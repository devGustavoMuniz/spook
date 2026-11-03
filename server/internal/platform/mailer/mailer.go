// Package mailer envia e-mails. A interface é mínima e definida por quem consome (fluxos por e-mail):
// há o envio SMTP, o driver `log` (padrão em dev: escreve no log estruturado) e o `Memory` dos testes.
package mailer

import (
	"context"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// Message é um e-mail pronto para envio (texto e HTML simples, sem imagens remotas).
type Message struct {
	To      string
	Subject string
	Text    string
	HTML    string
}

// Sender entrega uma mensagem. Implementações precisam ser seguras para uso concorrente.
type Sender interface {
	Send(ctx context.Context, m Message) error
}

// Log escreve o e-mail no log estruturado em vez de enviar. Em produção o corpo (que contém o link com o
// token) NUNCA é logado: só destinatário e assunto. Em desenvolvimento (Verbose) o corpo vai ao log e à
// caixa de saída em memória, para o E2E ler o link.
type Log struct {
	Verbose bool
	Outbox  *Outbox // opcional; só preenchido em desenvolvimento
}

func (l Log) Send(ctx context.Context, m Message) error {
	attrs := []any{"to", Mask(m.To), "subject", m.Subject}
	if l.Verbose {
		attrs = []any{"to", m.To, "subject", m.Subject, "text", m.Text}
		if l.Outbox != nil {
			l.Outbox.Add(m)
		}
	}
	slog.InfoContext(ctx, "e-mail (driver log, nada foi enviado)", attrs...)
	return nil
}

// Mask esconde a maior parte do endereço para logs ("ma***@exemplo.com").
func Mask(addr string) string {
	at := strings.LastIndexByte(addr, '@')
	if at < 1 {
		return "***"
	}
	local := addr[:at]
	if len(local) > 2 {
		local = local[:2]
	}
	return local + "***" + addr[at:]
}

// Outbox guarda os últimos e-mails (só em memória, só em desenvolvimento).
type Outbox struct {
	mu   sync.Mutex
	msgs []Stamped
}

type Stamped struct {
	Message
	At time.Time
}

const outboxMax = 50

func (o *Outbox) Add(m Message) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.msgs = append(o.msgs, Stamped{Message: m, At: time.Now()})
	if len(o.msgs) > outboxMax {
		o.msgs = o.msgs[len(o.msgs)-outboxMax:]
	}
}

// Last devolve o e-mail mais recente para `to` (sem diferenciar maiúsculas).
func (o *Outbox) Last(to string) (Stamped, bool) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for i := len(o.msgs) - 1; i >= 0; i-- {
		if strings.EqualFold(o.msgs[i].To, to) {
			return o.msgs[i], true
		}
	}
	return Stamped{}, false
}

// Memory é o dublê dos testes: guarda tudo e pode simular falhas.
type Memory struct {
	mu       sync.Mutex
	Sent     []Message
	FailNext int // quantos envios seguintes devem falhar
	Err      error
}

func (m *Memory) Send(_ context.Context, msg Message) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.FailNext > 0 {
		m.FailNext--
		if m.Err != nil {
			return m.Err
		}
		return errSimulated
	}
	m.Sent = append(m.Sent, msg)
	return nil
}

// To devolve as mensagens enviadas a um destinatário.
func (m *Memory) To(addr string) []Message {
	m.mu.Lock()
	defer m.mu.Unlock()
	var out []Message
	for _, s := range m.Sent {
		if strings.EqualFold(s.To, addr) {
			out = append(out, s)
		}
	}
	return out
}

// Count devolve quantas mensagens foram enviadas.
func (m *Memory) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.Sent)
}

type simulated struct{}

func (simulated) Error() string { return "falha simulada de envio" }

var errSimulated error = simulated{}
