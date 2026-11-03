package social

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
)

// Intenções do fluxo.
const (
	IntentLogin  = "login"  // entrar ou criar conta
	IntentLink   = "link"   // vincular o provedor à conta logada (exige senha confirmada há pouco)
	IntentReauth = "reauth" // reconfirmar a identidade de quem não tem senha (libera as ações sensíveis)
)

// flowTTL é a validade do fluxo (cookie assinado e estado).
const flowTTL = 10 * time.Minute

// flow é o que o cookie assinado `spook_oauth` guarda durante a ida ao provedor. É assinado (não cifrado):
// não contém segredo do provedor, só o estado, o verificador PKCE e o destino.
type flow struct {
	Provider string `json:"p"`
	State    string `json:"s"`
	Verifier string `json:"v"`
	Intent   string `json:"i"`
	UserID   int64  `json:"u,omitempty"`
	Redirect string `json:"r"`
	Expires  int64  `json:"e"`
}

var errBadFlow = errors.New("fluxo OAuth inválido")

func randomString(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// newFlow gera estado e verificador PKCE novos.
func newFlow(provider, intent, redirect string, userID int64, now time.Time) (flow, error) {
	state, err := randomString(24)
	if err != nil {
		return flow{}, err
	}
	verifier, err := randomString(48) // 64 caracteres, dentro de 43..128
	if err != nil {
		return flow{}, err
	}
	return flow{Provider: provider, State: state, Verifier: verifier, Intent: intent, UserID: userID,
		Redirect: SafeRedirect(redirect), Expires: now.Add(flowTTL).Unix()}, nil
}

func (f flow) challenge() string {
	sum := sha256.Sum256([]byte(f.Verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

func (f flow) seal(box *secret.Box) string {
	raw, _ := json.Marshal(f)
	return box.Sign(raw)
}

// openFlow valida assinatura, prazo, provedor e estado (comparação em tempo constante, na assinatura e no estado).
func openFlow(box *secret.Box, cookie, provider, state string, now time.Time) (flow, error) {
	raw, err := box.Verify(cookie)
	if err != nil {
		return flow{}, errBadFlow
	}
	var f flow
	if err := json.Unmarshal(raw, &f); err != nil {
		return flow{}, errBadFlow
	}
	if f.Expires < now.Unix() || f.Provider != provider || f.State == "" || !constEq(f.State, state) {
		return flow{}, errBadFlow
	}
	return f, nil
}

func constEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var d byte
	for i := 0; i < len(a); i++ {
		d |= a[i] ^ b[i]
	}
	return d == 0
}

// SafeRedirect aceita só caminhos internos ("/algo"): evita o redirecionamento aberto depois do login.
func SafeRedirect(r string) string {
	if r == "" || len(r) > 512 || r[0] != '/' || strings.HasPrefix(r, "//") || strings.ContainsAny(r, "\\\r\n\t") {
		return "/"
	}
	u, err := url.Parse(r)
	if err != nil || u.Scheme != "" || u.Host != "" {
		return "/"
	}
	return r
}

// withParam acrescenta ?k=v (ou &k=v) a um caminho interno.
func withParam(path, k, v string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + url.QueryEscape(k) + "=" + url.QueryEscape(v)
}

// suggestUsername deriva um username válido (a-z0-9_. , 2 a 32) do nome ou do e-mail do provedor.
func suggestUsername(name, email string) string {
	base := name
	if i := strings.IndexByte(email, '@'); strings.TrimSpace(base) == "" && i > 0 {
		base = email[:i]
	}
	var b strings.Builder
	for _, r := range strings.ToLower(base) {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '_', r == '.':
			b.WriteRune(r)
		case r == ' ' || r == '-':
			b.WriteRune('_')
		}
	}
	out := b.String()
	if utf8.RuneCountInString(out) > 28 {
		out = out[:28]
	}
	if utf8.RuneCountInString(out) < 2 {
		out = "usuario"
	}
	return out
}
