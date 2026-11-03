package mailer

import (
	"bufio"
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/mail"
	"strings"
	"testing"
	"time"
)

func TestRenderEscapesAndHasLink(t *testing.T) {
	m, err := Render(TemplateVerify, Data{To: "a@b.com", Username: `<b>x</b>`, URL: "https://x.test/verify-email?token=abc&y=1", TTL: "24 horas"})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(m.Text, "https://x.test/verify-email?token=abc&y=1") || !strings.Contains(m.HTML, "href=\"https://x.test/verify-email?token=abc&amp;y=1\"") {
		t.Fatalf("link ausente:\n%s\n%s", m.Text, m.HTML)
	}
	if strings.Contains(m.HTML, "<b>x</b>") {
		t.Fatal("HTML não escapou o username")
	}
	if strings.Contains(m.HTML, "http://") && strings.Contains(m.HTML, "src=") {
		t.Fatal("sem imagens remotas")
	}
	if _, err := Render("nope", Data{}); err == nil {
		t.Fatal("modelo desconhecido deve falhar")
	}
	for _, tpl := range []Template{TemplateEmailChange, TemplateEmailChangeNotice, TemplateEmailChanged, TemplatePasswordReset} {
		if m, err := Render(tpl, Data{To: "a@b.com", URL: "https://x/y", Other: "o@b.com", TTL: "30 minutos"}); err != nil || m.Subject == "" || m.Text == "" {
			t.Fatalf("%s: %v", tpl, err)
		}
	}
}

func TestLogDoesNotLeakBodyUnlessVerbose(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, nil)))
	defer slog.SetDefault(old)
	msg := Message{To: "maria@exemplo.com", Subject: "Assunto", Text: "link https://x/?token=SEGREDO"}
	_ = Log{}.Send(context.Background(), msg)
	if strings.Contains(buf.String(), "SEGREDO") || strings.Contains(buf.String(), "maria@") {
		t.Fatalf("produção não pode logar token nem endereço inteiro: %s", buf.String())
	}
	buf.Reset()
	ob := &Outbox{}
	_ = Log{Verbose: true, Outbox: ob}.Send(context.Background(), msg)
	if !strings.Contains(buf.String(), "SEGREDO") {
		t.Fatal("dev deve logar o link")
	}
	if got, ok := ob.Last("MARIA@exemplo.com"); !ok || got.Subject != "Assunto" {
		t.Fatal("caixa de saída")
	}
}

func TestMemoryFailures(t *testing.T) {
	m := &Memory{FailNext: 1}
	if err := m.Send(context.Background(), Message{To: "a@b.c"}); err == nil {
		t.Fatal("deveria falhar")
	}
	if err := m.Send(context.Background(), Message{To: "a@b.c"}); err != nil || m.Count() != 1 {
		t.Fatal("segundo envio deve passar")
	}
}

func TestBuildStripsHeaderInjection(t *testing.T) {
	from := mustAddr(t, "Spook <no-reply@x.test>")
	to := mustAddr(t, "a@b.test")
	raw := string(build(from, to, Message{Subject: "Oi\r\nBcc: vitima@x.test", Text: "t", HTML: "<p>h</p>"}))
	head := raw[:strings.Index(raw, "\r\n\r\n")]
	if strings.Contains(head, "\r\nBcc:") {
		t.Fatalf("injeção de cabeçalho: %s", head)
	}
}

// Servidor SMTP mínimo em texto puro (porta != 465, sem STARTTLS e sem credenciais) para testar o fluxo.
func TestSMTPSendPlain(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = ln.Close() }()
	got := make(chan string, 1)
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		r := bufio.NewReader(c)
		w := func(s string) { _, _ = c.Write([]byte(s + "\r\n")) }
		w("220 fake ESMTP")
		var data strings.Builder
		inData := false
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if inData {
				if line == "." {
					inData = false
					got <- data.String()
					w("250 ok")
					continue
				}
				data.WriteString(line + "\n")
				continue
			}
			switch {
			case strings.HasPrefix(line, "EHLO"):
				w("250 fake")
			case strings.HasPrefix(line, "MAIL"), strings.HasPrefix(line, "RCPT"):
				w("250 ok")
			case line == "DATA":
				inData = true
				w("354 go")
			case line == "QUIT":
				w("221 bye")
				return
			default:
				w("250 ok")
			}
		}
	}()
	host, portStr, _ := net.SplitHostPort(ln.Addr().String())
	port := 0
	for _, ch := range portStr {
		port = port*10 + int(ch-'0')
	}
	s := NewSMTP(SMTPConfig{Host: host, Port: port, From: "Spook <no-reply@x.test>", Timeout: 3 * time.Second})
	if err := s.Send(context.Background(), Message{To: "dest@x.test", Subject: "Olá", Text: "corpo", HTML: "<p>corpo</p>"}); err != nil {
		t.Fatal(err)
	}
	select {
	case d := <-got:
		if !strings.Contains(d, "To: <dest@x.test>") && !strings.Contains(d, "To: ") {
			t.Fatalf("mensagem sem To: %s", d)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("servidor não recebeu a mensagem")
	}
}

func mustAddr(t *testing.T, s string) *mail.Address {
	t.Helper()
	a, err := mail.ParseAddress(s)
	if err != nil {
		t.Fatal(err)
	}
	return a
}
