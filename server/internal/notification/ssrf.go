package notification

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"syscall"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// ErrBlockedAddress: o destino resolve para um endereço interno (anti-SSRF). Não vale tentar de novo.
var ErrBlockedAddress = errors.New("endereço de destino não permitido")

const maxEndpointLen = 2048

// blockedPrefixes são as faixas, além das que o netip já classifica, que um serviço de push público nunca usa.
var blockedPrefixes = []netip.Prefix{
	netip.MustParsePrefix("0.0.0.0/8"),       // "esta rede"
	netip.MustParsePrefix("100.64.0.0/10"),   // CGNAT
	netip.MustParsePrefix("192.0.0.0/24"),    // protocolo IETF
	netip.MustParsePrefix("192.0.2.0/24"),    // documentação
	netip.MustParsePrefix("198.18.0.0/15"),   // benchmark
	netip.MustParsePrefix("198.51.100.0/24"), // documentação
	netip.MustParsePrefix("203.0.113.0/24"),  // documentação
	netip.MustParsePrefix("240.0.0.0/4"),     // reservado (inclui o broadcast)
	netip.MustParsePrefix("64:ff9b::/96"),    // NAT64: esconde um IPv4 qualquer
	netip.MustParsePrefix("2001:db8::/32"),   // documentação
}

// BlockedAddr diz se o IP é de uso interno: loopback, privado (10/8, 172.16/12, 192.168/16, fc00::/7),
// link-local (169.254/16, inclusive o endpoint de metadados da nuvem, e fe80::/10), não especificado,
// multicast e as faixas reservadas acima. IPv4 embutido em IPv6 ("::ffff:10.0.0.1") é desembrulhado.
func BlockedAddr(a netip.Addr) bool {
	a = a.Unmap()
	if !a.IsValid() || a.IsLoopback() || a.IsPrivate() || a.IsLinkLocalUnicast() || a.IsLinkLocalMulticast() ||
		a.IsInterfaceLocalMulticast() || a.IsMulticast() || a.IsUnspecified() {
		return true
	}
	for _, p := range blockedPrefixes {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// Resolver resolve nomes (net.Resolver implementa; os testes injetam um falso).
type Resolver interface {
	LookupNetIP(ctx context.Context, network, host string) ([]netip.Addr, error)
}

// EndpointPolicy decide quais endpoints de push são aceitos. O padrão (zero) é o de produção.
type EndpointPolicy struct {
	// AllowPrivate relaxa a checagem de IP e de porta. Existe só para os testes de integração, em que o
	// "serviço de push" é um servidor de teste em 127.0.0.1; nunca é ligado pela configuração.
	AllowPrivate bool
	Resolver     Resolver // padrão: net.DefaultResolver
}

func (p EndpointPolicy) resolver() Resolver {
	if p.Resolver != nil {
		return p.Resolver
	}
	return net.DefaultResolver
}

// Validate confere o endpoint informado na inscrição: URL https sem credenciais, porta 443 e nenhum
// endereço resolvido interno. O envio repete a checagem no momento da conexão (DialControl), que é a que
// vale contra DNS que muda entre a inscrição e o envio.
func (p EndpointPolicy) Validate(ctx context.Context, raw string) error {
	bad := func(msg string) error { return apperr.Invalid("endpoint de push inválido: " + msg) }
	if len(raw) == 0 || len(raw) > maxEndpointLen {
		return bad("tamanho inválido")
	}
	u, err := url.Parse(raw)
	if err != nil || !u.IsAbs() {
		return bad("URL malformada")
	}
	if !strings.EqualFold(u.Scheme, "https") {
		return bad("só https é aceito")
	}
	if u.User != nil {
		return bad("credenciais na URL não são aceitas")
	}
	host := u.Hostname()
	if host == "" {
		return bad("sem host")
	}
	if port := u.Port(); !p.AllowPrivate && port != "" && port != "443" {
		return bad("só a porta 443 é aceita")
	}
	if p.AllowPrivate {
		return nil
	}
	if a, err := netip.ParseAddr(host); err == nil { // IP literal
		if BlockedAddr(a) {
			return apperr.Invalid("endpoint de push inválido: destino em rede interna não é permitido")
		}
		return nil
	}
	if strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost") {
		return apperr.Invalid("endpoint de push inválido: destino em rede interna não é permitido")
	}
	lctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	addrs, err := p.resolver().LookupNetIP(lctx, "ip", host)
	if err != nil || len(addrs) == 0 {
		return bad("não foi possível resolver o endereço")
	}
	for _, a := range addrs {
		if BlockedAddr(a) {
			return apperr.Invalid("endpoint de push inválido: destino em rede interna não é permitido")
		}
	}
	return nil
}

// dialControl é o net.Dialer.Control que recusa a conexão ao IP já resolvido que for interno. Roda a cada
// conexão (inclusive reutilizando o DNS), então vale também contra "DNS rebinding".
func dialControl(network, address string, _ syscall.RawConn) error {
	ap, err := netip.ParseAddrPort(address)
	if err != nil {
		return ErrBlockedAddress
	}
	if BlockedAddr(ap.Addr()) {
		return ErrBlockedAddress
	}
	return nil
}

// NewHTTPClient é o cliente HTTP do envio: timeout curto, sem proxy do ambiente, sem seguir redirecionamentos
// e com o dialer anti-SSRF (a menos que a política relaxe, nos testes).
func NewHTTPClient(p EndpointPolicy, timeout time.Duration) *http.Client {
	d := &net.Dialer{Timeout: 5 * time.Second, KeepAlive: 30 * time.Second}
	if !p.AllowPrivate {
		d.Control = dialControl
	}
	return &http.Client{
		Timeout: timeout,
		Transport: &http.Transport{
			Proxy:                 nil,
			DialContext:           d.DialContext,
			TLSHandshakeTimeout:   5 * time.Second,
			ResponseHeaderTimeout: timeout,
			MaxIdleConns:          20,
			MaxIdleConnsPerHost:   4,
			IdleConnTimeout:       60 * time.Second,
		},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}
