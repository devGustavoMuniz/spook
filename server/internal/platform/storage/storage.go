// Package storage fala S3 genérico (URLs pré-assinadas). Nada aqui é específico de um
// fornecedor: funciona com Garage, MinIO, AWS S3 ou qualquer servidor compatível.
package storage

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
)

var (
	// ErrNotFound: o objeto não existe.
	ErrNotFound = errors.New("objeto não encontrado")
	// ErrTooLarge: o objeto passa do limite de bytes pedido por quem lê.
	ErrTooLarge = errors.New("objeto maior que o limite")
)

// ObjectInfo são os metadados de um objeto (HEAD).
type ObjectInfo struct {
	Size        int64
	ContentType string
}

type Config struct {
	Endpoint        string
	Region          string
	Bucket          string
	AccessKeyID     string
	SecretAccessKey string
}

type Store struct {
	bucket  string
	client  *s3.Client
	presign *s3.PresignClient
}

func New(ctx context.Context, cfg Config) (*Store, error) {
	awsCfg, err := awsconfig.LoadDefaultConfig(ctx,
		awsconfig.WithRegion(cfg.Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(cfg.AccessKeyID, cfg.SecretAccessKey, "")),
	)
	if err != nil {
		return nil, fmt.Errorf("carregar config S3: %w", err)
	}
	client := s3.NewFromConfig(awsCfg, func(o *s3.Options) {
		o.BaseEndpoint = aws.String(cfg.Endpoint)
		o.UsePathStyle = true // servidores self-hosted não têm DNS por bucket
	})
	return &Store{bucket: cfg.Bucket, client: client, presign: s3.NewPresignClient(client)}, nil
}

// PresignPut gera a URL para o cliente enviar o objeto direto ao storage.
// Content-Type e tamanho (se size > 0) fazem parte da assinatura: o cliente precisa enviá-los iguais.
func (s *Store) PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error) {
	in := &s3.PutObjectInput{
		Bucket:      aws.String(s.bucket),
		Key:         aws.String(key),
		ContentType: aws.String(contentType),
	}
	if size > 0 {
		in.ContentLength = aws.Int64(size)
	}
	req, err := s.presign.PresignPutObject(ctx, in, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("assinar PUT de %q: %w", key, err)
	}
	return req.URL, nil
}

func (s *Store) PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error) {
	req, err := s.presign.PresignGetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.bucket),
		Key:    aws.String(key),
	}, s3.WithPresignExpires(ttl))
	if err != nil {
		return "", fmt.Errorf("assinar GET de %q: %w", key, err)
	}
	return req.URL, nil
}

// isNotFound reconhece "não existe" nas variações de servidores S3 (HEAD devolve NotFound; GET, NoSuchKey).
func isNotFound(err error) bool {
	var apiErr smithy.APIError
	if errors.As(err, &apiErr) {
		switch apiErr.ErrorCode() {
		case "NotFound", "NoSuchKey":
			return true
		}
	}
	return false
}

// Stat devolve o tamanho e o Content-Type do objeto (HEAD); ErrNotFound se não existir.
func (s *Store) Stat(ctx context.Context, key string) (ObjectInfo, error) {
	out, err := s.client.HeadObject(ctx, &s3.HeadObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		if isNotFound(err) {
			return ObjectInfo{}, ErrNotFound
		}
		return ObjectInfo{}, fmt.Errorf("HEAD de %q: %w", key, err)
	}
	return ObjectInfo{Size: aws.ToInt64(out.ContentLength), ContentType: aws.ToString(out.ContentType)}, nil
}

// GetRange lê até length bytes a partir de offset (os primeiros bytes de um arquivo, por exemplo).
// Objeto menor que o intervalo devolve o que existe.
func (s *Store) GetRange(ctx context.Context, key string, offset, length int64) ([]byte, error) {
	if length <= 0 {
		return nil, nil
	}
	rng := fmt.Sprintf("bytes=%d-%d", offset, offset+length-1)
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key), Range: aws.String(rng)})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		var apiErr smithy.APIError
		if errors.As(err, &apiErr) && apiErr.ErrorCode() == "InvalidRange" { // objeto vazio
			return nil, nil
		}
		return nil, fmt.Errorf("GET de %q: %w", key, err)
	}
	defer func() { _ = out.Body.Close() }()
	b, err := io.ReadAll(io.LimitReader(out.Body, length))
	if err != nil {
		return nil, fmt.Errorf("ler %q: %w", key, err)
	}
	return b, nil
}

// Get lê o objeto inteiro, no máximo maxBytes; ErrTooLarge se passar (sem baixar o resto).
func (s *Store) Get(ctx context.Context, key string, maxBytes int64) ([]byte, error) {
	out, err := s.client.GetObject(ctx, &s3.GetObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)})
	if err != nil {
		if isNotFound(err) {
			return nil, ErrNotFound
		}
		return nil, fmt.Errorf("GET de %q: %w", key, err)
	}
	defer func() { _ = out.Body.Close() }()
	if n := aws.ToInt64(out.ContentLength); n > maxBytes {
		return nil, ErrTooLarge
	}
	b, err := io.ReadAll(io.LimitReader(out.Body, maxBytes+1))
	if err != nil {
		return nil, fmt.Errorf("ler %q: %w", key, err)
	}
	if int64(len(b)) > maxBytes {
		return nil, ErrTooLarge
	}
	return b, nil
}

// Put grava o objeto (usado para os thumbnails gerados no servidor).
func (s *Store) Put(ctx context.Context, key, contentType string, data []byte) error {
	_, err := s.client.PutObject(ctx, &s3.PutObjectInput{
		Bucket: aws.String(s.bucket), Key: aws.String(key), Body: bytes.NewReader(data),
		ContentType: aws.String(contentType), ContentLength: aws.Int64(int64(len(data))),
	})
	if err != nil {
		return fmt.Errorf("PUT de %q: %w", key, err)
	}
	return nil
}

// Delete remove o objeto; apagar o que não existe não é erro.
func (s *Store) Delete(ctx context.Context, key string) error {
	if _, err := s.client.DeleteObject(ctx, &s3.DeleteObjectInput{Bucket: aws.String(s.bucket), Key: aws.String(key)}); err != nil {
		if isNotFound(err) {
			return nil
		}
		return fmt.Errorf("DELETE de %q: %w", key, err)
	}
	return nil
}
