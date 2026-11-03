package social

import (
	"context"
	"net/url"
	"strings"
)

// GoogleEndpoints são os endereços do Google (substituíveis nos testes).
type GoogleEndpoints struct{ Auth, Token, UserInfo string }

var googleDefaults = GoogleEndpoints{
	Auth:     "https://accounts.google.com/o/oauth2/v2/auth",
	Token:    "https://oauth2.googleapis.com/token",
	UserInfo: "https://openidconnect.googleapis.com/v1/userinfo",
}

type googleProvider struct {
	id, secret string
	ep         GoogleEndpoints
	c          HTTPDoer
}

// NewGoogle: authorization code + PKCE. O perfil vem do endpoint userinfo com o token recém-trocado (TLS direto
// com o Google), em vez de validar o ID token por JWKS: o resultado é o mesmo e há menos código criptográfico.
func NewGoogle(clientID, secret string, c HTTPDoer, ep *GoogleEndpoints) Provider {
	e := googleDefaults
	if ep != nil {
		e = *ep
	}
	return &googleProvider{id: clientID, secret: secret, ep: e, c: defaultClient(c)}
}

func (g *googleProvider) Name() string { return Google }

func (g *googleProvider) AuthURL(p AuthParams) string {
	q := url.Values{
		"client_id": {g.id}, "redirect_uri": {p.RedirectURI}, "response_type": {"code"},
		"scope": {"openid email profile"}, "state": {p.State},
		"code_challenge": {p.Challenge}, "code_challenge_method": {"S256"},
	}
	if p.Reauth {
		q.Set("prompt", "select_account")
	}
	return g.ep.Auth + "?" + q.Encode()
}

func (g *googleProvider) Exchange(ctx context.Context, code, verifier, redirectURI string) (Profile, error) {
	tok, err := tokenRequest(ctx, g.c, g.ep.Token, url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "client_id": {g.id}, "client_secret": {g.secret},
		"redirect_uri": {redirectURI}, "code_verifier": {verifier},
	})
	if err != nil {
		return Profile{}, err
	}
	var u struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
	}
	if err := getJSON(ctx, g.c, g.ep.UserInfo, tok, &u); err != nil {
		return Profile{}, err
	}
	return Profile{ID: u.Sub, Email: strings.TrimSpace(u.Email), EmailVerified: u.EmailVerified, Name: strings.TrimSpace(u.Name)}, nil
}
