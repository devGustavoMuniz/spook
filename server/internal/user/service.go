package user

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// Store é o que o service precisa do banco.
type Store interface {
	Create(ctx context.Context, id int64, email, username, passwordHash string) (User, error)
	ByID(ctx context.Context, id int64) (User, error)
	ByEmail(ctx context.Context, email string) (User, string, error)
	UpdateProfile(ctx context.Context, id int64, displayName, avatarKey *string) (User, error)
}

// AvatarStorage é o que o service precisa do storage S3 (URLs pré-assinadas).
type AvatarStorage interface {
	PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}

type IDGenerator interface{ Next() int64 }

const (
	MaxAvatarBytes = 5 << 20
	avatarPutTTL   = 5 * time.Minute
	avatarGetTTL   = time.Hour
)

var avatarTypes = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}

type Service struct {
	store   Store
	storage AvatarStorage // pode ser nil: avatar desativado
	ids     IDGenerator
}

func NewService(store Store, storage AvatarStorage, ids IDGenerator) *Service {
	return &Service{store: store, storage: storage, ids: ids}
}

func (s *Service) Create(ctx context.Context, email, username, passwordHash string) (User, error) {
	return s.store.Create(ctx, s.ids.Next(), strings.TrimSpace(email), username, passwordHash)
}

func (s *Service) Get(ctx context.Context, id int64) (User, error) { return s.store.ByID(ctx, id) }

// Credentials devolve o usuário e o hash da senha, para o login (pacote auth).
func (s *Service) Credentials(ctx context.Context, email string) (User, string, error) {
	return s.store.ByEmail(ctx, strings.TrimSpace(email))
}

type ProfileUpdate struct {
	DisplayName  *string // nil = não altera; "" = remove
	AvatarKey    *string // nil = não altera
	RemoveAvatar bool
}

func (s *Service) UpdateProfile(ctx context.Context, id int64, in ProfileUpdate) (User, error) {
	cur, err := s.store.ByID(ctx, id)
	if err != nil {
		return User{}, err
	}
	displayName, avatarKey := cur.DisplayName, cur.AvatarKey

	if in.DisplayName != nil {
		name := strings.TrimSpace(*in.DisplayName)
		if name == "" {
			displayName = nil
		} else {
			displayName = &name
		}
	}
	switch {
	case in.RemoveAvatar:
		avatarKey = nil
	case in.AvatarKey != nil:
		// O cliente só pode apontar para chaves geradas para ele em RequestAvatarUpload.
		if !strings.HasPrefix(*in.AvatarKey, avatarPrefix(id)) {
			return User{}, ErrInvalidAvatar
		}
		avatarKey = in.AvatarKey
	}
	return s.store.UpdateProfile(ctx, id, displayName, avatarKey)
}

type AvatarUpload struct {
	URL string
	Key string
}

// RequestAvatarUpload devolve uma URL pré-assinada para o cliente enviar o avatar direto ao storage.
func (s *Service) RequestAvatarUpload(ctx context.Context, userID int64, contentType string, size int64) (AvatarUpload, error) {
	if s.storage == nil {
		return AvatarUpload{}, fmt.Errorf("storage não configurado")
	}
	ext, ok := avatarTypes[contentType]
	if !ok || size <= 0 || size > MaxAvatarBytes {
		return AvatarUpload{}, ErrInvalidAvatar
	}
	key := fmt.Sprintf("%s%d.%s", avatarPrefix(userID), s.ids.Next(), ext)
	url, err := s.storage.PresignPut(ctx, key, contentType, size, avatarPutTTL)
	if err != nil {
		return AvatarUpload{}, err
	}
	return AvatarUpload{URL: url, Key: key}, nil
}

// AvatarURL devolve uma URL de leitura temporária, ou "" se não houver avatar.
func (s *Service) AvatarURL(ctx context.Context, u User) string {
	if s.storage == nil || u.AvatarKey == nil {
		return ""
	}
	url, err := s.storage.PresignGet(ctx, *u.AvatarKey, avatarGetTTL)
	if err != nil {
		return ""
	}
	return url
}

func avatarPrefix(userID int64) string { return fmt.Sprintf("avatars/%d/", userID) }

// AvatarURLForKey devolve a URL de leitura de uma chave de avatar, ou "" se não houver.
func (s *Service) AvatarURLForKey(ctx context.Context, key *string) string {
	return s.AvatarURL(ctx, User{AvatarKey: key})
}
