package download

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

const (
	defaultAPIBase = "https://api.github.com"
	requestTimeout = 5 * time.Second
	maxBodyBytes   = 1 << 20 // 1 MB
)

var (
	// ErrNoRelease: o GitHub respondeu 404 (ainda não há release publicado).
	ErrNoRelease = errors.New("download: nenhum release publicado")
	// ErrBodyTooLarge: a resposta passou do limite de corpo.
	ErrBodyTooLarge = errors.New("download: resposta grande demais")
)

// Source busca o último release no GitHub. É a interface mínima que o service consome (troca real: dublê nos testes).
// etag é o ETag da última resposta boa ("" na primeira busca); notModified vale true quando o GitHub respondeu 304.
type Source interface {
	Latest(ctx context.Context, etag string) (body []byte, newETag string, notModified bool, err error)
}

// GitHub é o cliente HTTP real da API de releases.
type GitHub struct {
	repo    string
	token   string
	apiBase string
	client  *http.Client
}

// NewGitHub cria o cliente para repo (dono/repo, já validado). token é opcional e nunca é logado.
func NewGitHub(repo, token string) *GitHub {
	return &GitHub{repo: repo, token: token, apiBase: defaultAPIBase, client: &http.Client{Timeout: requestTimeout}}
}

// PageURL é a página de releases do repositório (fallback quando o release não traz html_url).
func (g *GitHub) PageURL() string { return "https://github.com/" + g.repo + "/releases" }

func (g *GitHub) Latest(ctx context.Context, etag string) ([]byte, string, bool, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, g.apiBase+"/repos/"+g.repo+"/releases/latest", nil)
	if err != nil {
		return nil, "", false, err
	}
	req.Header.Set("User-Agent", "spook-backend")
	req.Header.Set("Accept", "application/vnd.github+json")
	if g.token != "" {
		req.Header.Set("Authorization", "Bearer "+g.token)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	res, err := g.client.Do(req)
	if err != nil {
		// url.Error pode conter a URL; nunca o token (vai só no cabeçalho).
		return nil, "", false, fmt.Errorf("consultar o GitHub: %w", err)
	}
	defer func() { _ = res.Body.Close() }()
	switch {
	case res.StatusCode == http.StatusNotModified:
		return nil, etag, true, nil
	case res.StatusCode == http.StatusNotFound:
		return nil, "", false, ErrNoRelease
	case res.StatusCode != http.StatusOK:
		return nil, "", false, fmt.Errorf("GitHub respondeu %d", res.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(res.Body, maxBodyBytes+1))
	if err != nil {
		return nil, "", false, fmt.Errorf("ler a resposta do GitHub: %w", err)
	}
	if len(body) > maxBodyBytes {
		return nil, "", false, ErrBodyTooLarge
	}
	return body, res.Header.Get("ETag"), false, nil
}
