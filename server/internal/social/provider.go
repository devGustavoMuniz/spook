// Package social cuida do login com Google e Discord (OAuth2 authorization code + PKCE): início e retorno do
// fluxo, vínculo e desvinculo de contas e o cadastro "escolha seu username". Os tokens de acesso do provedor
// vivem só em variáveis locais da troca do código: nunca são gravados nem logados.
package social

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Nomes dos provedores (também o valor de social_accounts.provider e o {provider} da URL).
const (
	Google  = "google"
	Discord = "discord"
)

// Profile é o que o spook usa do provedor: nada além disso é lido nem guardado.
type Profile struct {
	ID            string
	Email         string
	EmailVerified bool
	Name          string
}

// AuthParams monta a URL de autorização.
type AuthParams struct {
	State       string
	Challenge   string // PKCE S256
	RedirectURI string
	// Reauth pede ao provedor que mostre a escolha de conta de novo (reautenticação e vínculo).
	Reauth bool
}

// Provider é a porta para um provedor OAuth2. Os testes usam um dublê: nada chama a rede.
type Provider interface {
	Name() string
	AuthURL(p AuthParams) string
	// Exchange troca o código (com o verificador PKCE) pelo perfil. O token de acesso fica só aqui dentro.
	Exchange(ctx context.Context, code, verifier, redirectURI string) (Profile, error)
}

// HTTPDoer é o cliente HTTP dos provedores (substituível nos testes).
type HTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// ErrProvider: falha ao falar com o provedor (código recusado, rede, resposta inválida).
var ErrProvider = errors.New("falha no provedor")

const maxBody = 1 << 20

func defaultClient(c HTTPDoer) HTTPDoer {
	if c != nil {
		return c
	}
	return &http.Client{Timeout: 10 * time.Second}
}

// tokenRequest faz o POST do token endpoint e devolve só o access_token.
func tokenRequest(ctx context.Context, c HTTPDoer, endpoint string, form url.Values) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	var out struct {
		AccessToken string `json:"access_token"`
	}
	if err := doJSON(c, req, &out); err != nil {
		return "", err
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("%w: resposta sem access_token", ErrProvider)
	}
	return out.AccessToken, nil
}

func getJSON(ctx context.Context, c HTTPDoer, endpoint, bearer string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/json")
	return doJSON(c, req, out)
}

// doJSON executa a requisição. Mensagens de erro nunca incluem o corpo (pode ter segredos) nem a URL.
func doJSON(c HTTPDoer, req *http.Request, out any) error {
	resp, err := c.Do(req)
	if err != nil {
		return fmt.Errorf("%w: requisição falhou", ErrProvider)
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBody))
	if err != nil {
		return fmt.Errorf("%w: leitura da resposta", ErrProvider)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return fmt.Errorf("%w: status %d", ErrProvider, resp.StatusCode)
	}
	if err := json.Unmarshal(body, out); err != nil {
		return fmt.Errorf("%w: resposta inválida", ErrProvider)
	}
	return nil
}
