package mailflow

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/riverqueue/river"

	"github.com/devGustavoMuniz/spook/server/internal/platform/mailer"
	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
)

// SendArgs é o job de envio de um e-mail. O token (quando há) vai CIFRADO em SealedToken: o texto em claro
// nunca fica na tabela de jobs. TokenID liga o job ao token para o envio ser idempotente.
type SendArgs struct {
	Template    string `json:"template"`
	To          string `json:"to"`
	Username    string `json:"username,omitempty"`
	Other       string `json:"other,omitempty"`
	TokenID     int64  `json:"token_id,omitempty"`
	SealedToken string `json:"sealed_token,omitempty"`
}

func (SendArgs) Kind() string { return "mail_send" }
func (SendArgs) InsertOpts() river.InsertOpts {
	// Retentativas com o backoff padrão do River; 8 tentativas cobrem uma queda de SMTP de algumas horas.
	return river.InsertOpts{Queue: river.QueueDefault, MaxAttempts: 8}
}

// Queue enfileira o envio; sem fila o service envia direto.
type Queue interface {
	Enqueue(ctx context.Context, args SendArgs) error
}

// Enqueuer liga o service ao client do River (criado depois dos workers).
type Enqueuer struct{ client *river.Client[pgx.Tx] }

func (e *Enqueuer) Set(c *river.Client[pgx.Tx]) { e.client = c }

func (e *Enqueuer) Enqueue(ctx context.Context, args SendArgs) error {
	if e == nil || e.client == nil {
		return ErrDisabled
	}
	if _, err := e.client.Insert(ctx, args, nil); err != nil {
		return fmt.Errorf("enfileirar e-mail: %w", err)
	}
	return nil
}

// Ready diz se há client de jobs ligado.
func (e *Enqueuer) Ready() bool { return e != nil && e.client != nil }

// TokenState é o que o worker precisa do banco.
type TokenState interface {
	TokenIsSendable(ctx context.Context, id int64) (bool, error)
	MarkSent(ctx context.Context, id int64) error
}

type SendWorker struct {
	river.WorkerDefaults[SendArgs]
	d *Deliverer
}

// Deliverer renderiza e envia um SendArgs (usado pelo worker e pelo envio direto quando não há fila).
type Deliverer struct {
	Sender    mailer.Sender
	Box       *secret.Box
	State     TokenState
	PublicURL string
}

// RegisterWorkers registra o worker de envio de e-mail.
func RegisterWorkers(w *river.Workers, d *Deliverer) { river.AddWorker(w, &SendWorker{d: d}) }

func (w *SendWorker) Work(ctx context.Context, job *river.Job[SendArgs]) error {
	ctx, span := tracer.Start(ctx, "mailflow.send")
	defer span.End()
	err := w.d.Deliver(ctx, job.Args)
	if err != nil {
		slog.Warn("envio de e-mail falhou", "tentativa", job.Attempt, "to", mailer.Mask(job.Args.To), "template", job.Args.Template, "err", err)
	}
	return err
}

// Timeout de um envio.
const sendTimeout = 30 * time.Second

// Deliver envia o e-mail descrito por a. Idempotente: se o token já foi usado, expirou ou já foi enviado,
// não envia nada e não é erro (retentativa depois de um sucesso parcial).
func (d *Deliverer) Deliver(ctx context.Context, a SendArgs) error {
	data := mailer.Data{To: a.To, Username: a.Username, Other: a.Other}
	tpl := mailer.Template(a.Template)
	if a.TokenID != 0 {
		ok, err := d.State.TokenIsSendable(ctx, a.TokenID)
		if err != nil {
			return err
		}
		if !ok {
			return nil
		}
		raw, err := d.Box.Open(a.SealedToken)
		if err != nil {
			// Chave mudou (reinício sem SPOOK_SECRET_KEY): o link não pode mais ser montado; o usuário pede outro.
			slog.Warn("token de e-mail ilegível (chave do servidor mudou); descartando", "token_id", a.TokenID)
			return nil
		}
		data.URL, data.TTL = d.link(tpl, raw), ttlText(tpl)
	}
	msg, err := mailer.Render(tpl, data)
	if err != nil {
		return nil // modelo desconhecido não melhora com retentativa
	}
	sctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()
	if err := d.Sender.Send(sctx, msg); err != nil {
		return err
	}
	if a.TokenID != 0 {
		if err := d.State.MarkSent(ctx, a.TokenID); err != nil {
			slog.Warn("marcar e-mail enviado", "err", err)
		}
	}
	return nil
}

func (d *Deliverer) link(t mailer.Template, token string) string {
	path := "/verify-email"
	if t == mailer.TemplatePasswordReset {
		path = "/reset-password"
	}
	return d.PublicURL + path + "?token=" + token
}

func ttlText(t mailer.Template) string {
	if t == mailer.TemplatePasswordReset {
		return "30 minutos"
	}
	return "24 horas"
}
