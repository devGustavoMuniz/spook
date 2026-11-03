package social

import (
	"context"
	"net/url"
	"strings"
)

// DiscordEndpoints são os endereços do Discord (substituíveis nos testes).
type DiscordEndpoints struct{ Auth, Token, Me string }

var discordDefaults = DiscordEndpoints{
	Auth:  "https://discord.com/oauth2/authorize",
	Token: "https://discord.com/api/oauth2/token",
	Me:    "https://discord.com/api/users/@me",
}

type discordProvider struct {
	id, secret string
	ep         DiscordEndpoints
	c          HTTPDoer
}

// NewDiscord: authorization code + PKCE com escopos `identify email`.
func NewDiscord(clientID, secret string, c HTTPDoer, ep *DiscordEndpoints) Provider {
	e := discordDefaults
	if ep != nil {
		e = *ep
	}
	return &discordProvider{id: clientID, secret: secret, ep: e, c: defaultClient(c)}
}

func (d *discordProvider) Name() string { return Discord }

func (d *discordProvider) AuthURL(p AuthParams) string {
	q := url.Values{
		"client_id": {d.id}, "redirect_uri": {p.RedirectURI}, "response_type": {"code"},
		"scope": {"identify email"}, "state": {p.State},
		"code_challenge": {p.Challenge}, "code_challenge_method": {"S256"},
	}
	if p.Reauth {
		q.Set("prompt", "consent")
	}
	return d.ep.Auth + "?" + q.Encode()
}

func (d *discordProvider) Exchange(ctx context.Context, code, verifier, redirectURI string) (Profile, error) {
	tok, err := tokenRequest(ctx, d.c, d.ep.Token, url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "client_id": {d.id}, "client_secret": {d.secret},
		"redirect_uri": {redirectURI}, "code_verifier": {verifier},
	})
	if err != nil {
		return Profile{}, err
	}
	var u struct {
		ID         string `json:"id"`
		Username   string `json:"username"`
		GlobalName string `json:"global_name"`
		Email      string `json:"email"`
		Verified   bool   `json:"verified"`
	}
	if err := getJSON(ctx, d.c, d.ep.Me, tok, &u); err != nil {
		return Profile{}, err
	}
	name := strings.TrimSpace(u.GlobalName)
	if name == "" {
		name = strings.TrimSpace(u.Username)
	}
	return Profile{ID: u.ID, Email: strings.TrimSpace(u.Email), EmailVerified: u.Verified, Name: name}, nil
}
