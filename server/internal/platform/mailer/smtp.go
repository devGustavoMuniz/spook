package mailer

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"fmt"
	"mime"
	"net"
	"net/mail"
	"net/smtp"
	"strconv"
	"strings"
	"time"
)

// SMTPConfig é a conexão com o servidor de saída. Porta 465 usa TLS direto; as demais exigem STARTTLS
// quando há usuário/senha (credenciais nunca vão em claro).
type SMTPConfig struct {
	Host, User, Password, From string
	Port                       int
	// TLSConfig permite ao teste confiar no certificado do servidor falso (nil = padrão do sistema).
	TLSConfig *tls.Config
	Timeout   time.Duration
}

type SMTP struct{ c SMTPConfig }

func NewSMTP(c SMTPConfig) *SMTP {
	if c.Timeout == 0 {
		c.Timeout = 20 * time.Second
	}
	return &SMTP{c: c}
}

// Send entrega a mensagem. Erros não incluem a senha nem o corpo.
func (s *SMTP) Send(ctx context.Context, m Message) error {
	from, err := mail.ParseAddress(s.c.From)
	if err != nil {
		return fmt.Errorf("SMTP_FROM inválido: %w", err)
	}
	to, err := mail.ParseAddress(m.To)
	if err != nil {
		return fmt.Errorf("destinatário inválido: %w", err)
	}
	addr := net.JoinHostPort(s.c.Host, strconv.Itoa(s.c.Port))
	d := net.Dialer{Timeout: s.c.Timeout}
	tlsCfg := s.c.TLSConfig
	if tlsCfg == nil {
		tlsCfg = &tls.Config{ServerName: s.c.Host, MinVersion: tls.VersionTLS12}
	}
	raw, err := d.DialContext(ctx, "tcp", addr)
	if err != nil {
		return fmt.Errorf("conectar ao SMTP: %w", err)
	}
	conn := raw
	if s.c.Port == 465 {
		conn = tls.Client(raw, tlsCfg)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	} else {
		_ = conn.SetDeadline(time.Now().Add(s.c.Timeout * 2))
	}
	c, err := smtp.NewClient(conn, s.c.Host)
	if err != nil {
		_ = conn.Close()
		return fmt.Errorf("handshake SMTP: %w", err)
	}
	defer func() { _ = c.Close() }()
	if s.c.Port != 465 {
		if ok, _ := c.Extension("STARTTLS"); ok {
			if err := c.StartTLS(tlsCfg); err != nil {
				return fmt.Errorf("STARTTLS: %w", err)
			}
		} else if s.c.User != "" {
			return errors.New("o servidor SMTP não oferece STARTTLS; recusando enviar credenciais em claro")
		}
	}
	if s.c.User != "" {
		if err := c.Auth(plainAuth{user: s.c.User, pass: s.c.Password}); err != nil {
			return fmt.Errorf("autenticar no SMTP: %w", err)
		}
	}
	if err := c.Mail(from.Address); err != nil {
		return fmt.Errorf("MAIL FROM: %w", err)
	}
	if err := c.Rcpt(to.Address); err != nil {
		return fmt.Errorf("RCPT TO: %w", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("DATA: %w", err)
	}
	if _, err := w.Write(build(from, to, m)); err != nil {
		return fmt.Errorf("escrever mensagem: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("finalizar mensagem: %w", err)
	}
	return c.Quit()
}

// plainAuth é o AUTH PLAIN sem a trava de TLS do net/smtp (a trava de STARTTLS/465 já foi feita acima;
// o net/smtp recusa hosts que não sejam localhost sem TLS, o que atrapalha só os testes).
type plainAuth struct{ user, pass string }

func (a plainAuth) Start(*smtp.ServerInfo) (string, []byte, error) {
	return "PLAIN", []byte("\x00" + a.user + "\x00" + a.pass), nil
}
func (a plainAuth) Next(_ []byte, more bool) ([]byte, error) {
	if more {
		return nil, errors.New("resposta inesperada do servidor SMTP")
	}
	return nil, nil
}

// clean remove quebras de linha de cabeçalhos (injeção de cabeçalho).
func clean(s string) string { return strings.NewReplacer("\r", " ", "\n", " ").Replace(s) }

func build(from, to *mail.Address, m Message) []byte {
	boundary := "spook-" + strconv.FormatInt(time.Now().UnixNano(), 36)
	var b strings.Builder
	h := func(k, v string) { b.WriteString(k + ": " + v + "\r\n") }
	h("From", from.String())
	h("To", to.String())
	h("Subject", mime.QEncoding.Encode("utf-8", clean(m.Subject)))
	h("Date", time.Now().Format(time.RFC1123Z))
	h("MIME-Version", "1.0")
	h("Auto-Submitted", "auto-generated")
	h("Content-Type", `multipart/alternative; boundary="`+boundary+`"`)
	b.WriteString("\r\n")
	part := func(ct, body string) {
		b.WriteString("--" + boundary + "\r\n")
		b.WriteString("Content-Type: " + ct + "; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n")
		enc := base64.StdEncoding.EncodeToString([]byte(body))
		for len(enc) > 76 {
			b.WriteString(enc[:76] + "\r\n")
			enc = enc[76:]
		}
		b.WriteString(enc + "\r\n")
	}
	part("text/plain", m.Text)
	if m.HTML != "" {
		part("text/html", m.HTML)
	}
	b.WriteString("--" + boundary + "--\r\n")
	return []byte(b.String())
}
