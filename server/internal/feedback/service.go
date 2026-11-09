package feedback

import (
	"context"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

var tracer = otel.Tracer("spook/feedback")

// NewTicket são os dados de um chamado novo.
type NewTicket struct {
	ID        int64
	MessageID int64
	AuthorID  int64
	Kind      Kind
	Title     string
	Body      string
	Context   *TicketContext
}

// NewMessage é uma mensagem a gravar. Decide recebe o chamado travado e devolve o estado, a marca de "não lido" e se
// a mensagem conta no total público; erro cancela a gravação.
type NewMessage struct {
	ID       int64
	TicketID int64
	AuthorID int64
	Kind     MessageKind
	Body     string
	Decide   func(cur Ticket) (Decision, error)
}

// Decision é o efeito de uma mensagem no chamado. Nota interna não muda nada (Touch=false).
type Decision struct {
	Touch  bool
	Status Status
	Unread bool
}

// Store é o que o service precisa do banco.
type Store interface {
	// Create grava o chamado e a primeira mensagem na mesma transação.
	Create(ctx context.Context, t NewTicket) (Ticket, error)
	ActiveCount(ctx context.Context, authorID int64) (int64, error)
	ListByAuthor(ctx context.Context, authorID int64, status *Status, after *Cursor, limit int) ([]Ticket, error)
	Get(ctx context.Context, id int64) (AdminTicket, error) // ErrNotFound
	Messages(ctx context.Context, ticketID int64, includeInternal bool) ([]Message, error)
	AddMessage(ctx context.Context, m NewMessage) (Message, Ticket, error)
	// SetStatus troca o estado sob trava; decide devolve o estado e a marca de "não lido" finais.
	SetStatus(ctx context.Context, id int64, decide func(cur Ticket) (Status, bool, error)) (Ticket, error)
	MarkRead(ctx context.Context, id int64) error
	AdminList(ctx context.Context, f AdminFilter, after *Cursor, limit int) ([]AdminTicket, error)
	Counts(ctx context.Context) (TicketSummary, error)
}

// AdminFilter são os filtros da fila do administrador.
type AdminFilter struct {
	Status *Status
	Kind   *Kind
	Q      string
	Sort   Sort
}

// IDGenerator gera IDs Snowflake.
type IDGenerator interface{ Next() int64 }

// Admins responde se o usuário é administrador (implementado em app com admin.Service).
type Admins interface {
	IsAdmin(ctx context.Context, userID int64) (bool, error)
}

// Service reúne as regras dos chamados.
type Service struct {
	store  Store
	ids    IDGenerator
	pub    events.Publisher
	admins Admins

	changes metric.Int64Counter
}

func NewService(store Store, ids IDGenerator, pub events.Publisher, admins Admins) *Service {
	s := &Service{store: store, ids: ids, pub: pub, admins: admins}
	s.changes, _ = otel.Meter("spook/feedback").Int64Counter("spook.feedback.changes",
		metric.WithDescription("Mudanças em chamados, por ação (create, reply, admin_reply, note, status)"))
	return s
}

func (s *Service) count(ctx context.Context, action string) {
	s.changes.Add(ctx, 1, metric.WithAttributes(attribute.String("action", action)))
}

// IsAdmin diz se o usuário é administrador (a barreira das rotas /api/admin/tickets).
func (s *Service) IsAdmin(ctx context.Context, userID int64) (bool, error) {
	return s.admins.IsAdmin(ctx, userID)
}

func cleanBody(s string) (string, error) {
	s = strings.TrimSpace(s)
	if n := utf8.RuneCountInString(s); n < 1 || n > BodyMax {
		return "", ErrInvalidBody
	}
	return s, nil
}

func cleanContext(c *TicketContext) *TicketContext {
	if c == nil {
		return nil
	}
	cut := func(s string, n int) string {
		s = strings.TrimSpace(s)
		if utf8.RuneCountInString(s) > n {
			return string([]rune(s)[:n])
		}
		return s
	}
	out := &TicketContext{
		AppVersion: cut(c.AppVersion, 32), Client: cut(c.Client, 16), OS: cut(c.OS, 64),
		Browser: cut(c.Browser, 160), Route: cut(c.Route, 200), Locale: cut(c.Locale, 16),
	}
	if *out == (TicketContext{}) {
		return nil
	}
	return out
}

func (s *Service) emit(t Ticket, byAdmin bool) {
	s.pub.Publish(events.Event{
		Type: events.TicketUpdate, Topics: []string{"user:" + strconv.FormatInt(t.AuthorID, 10)},
		Data: TicketUpdatePayload{TicketPayload: payload(t), ByAdmin: byAdmin},
	})
}

// ---- autor ----

// Create abre um chamado com a primeira mensagem (a descrição).
func (s *Service) Create(ctx context.Context, userID int64, kind Kind, title, body string, c *TicketContext) (TicketDetail, error) {
	ctx, span := tracer.Start(ctx, "feedback.Create")
	defer span.End()
	if !kind.valid() {
		return TicketDetail{}, ErrInvalidKind
	}
	title = strings.TrimSpace(title)
	if n := utf8.RuneCountInString(title); n < TitleMin || n > TitleMax {
		return TicketDetail{}, ErrInvalidTitle
	}
	body, err := cleanBody(body)
	if err != nil {
		return TicketDetail{}, err
	}
	active, err := s.store.ActiveCount(ctx, userID)
	if err != nil {
		return TicketDetail{}, err
	}
	if active >= MaxActivePerUser {
		return TicketDetail{}, ErrTooManyActive
	}
	t, err := s.store.Create(ctx, NewTicket{
		ID: s.ids.Next(), MessageID: s.ids.Next(), AuthorID: userID, Kind: kind, Title: title, Body: body, Context: cleanContext(c),
	})
	if err != nil {
		return TicketDetail{}, err
	}
	s.count(ctx, "create")
	span.SetAttributes(attribute.String("ticket.id", httpx.ID(t.ID)), attribute.String("ticket.kind", string(kind)))
	s.emit(t, false)
	return s.detail(ctx, t, false)
}

// List devolve os chamados do próprio usuário, por atividade, com cursor.
func (s *Service) List(ctx context.Context, userID int64, status string, cursor string, limit int) (TicketPage, error) {
	ctx, span := tracer.Start(ctx, "feedback.List")
	defer span.End()
	var st *Status
	if status != "" {
		v := Status(status)
		if !v.valid() {
			return TicketPage{}, ErrInvalidStatus
		}
		st = &v
	}
	after, err := parseCursor(cursor, SortActivity)
	if err != nil {
		return TicketPage{}, err
	}
	limit = clampLimit(limit)
	rows, err := s.store.ListByAuthor(ctx, userID, st, after, limit+1)
	if err != nil {
		return TicketPage{}, err
	}
	next := (*string)(nil)
	if len(rows) > limit {
		rows = rows[:limit]
		c := encodeCursor(rows[limit-1], SortActivity)
		next = &c
	}
	out := make([]TicketPayload, len(rows))
	for i, t := range rows {
		out[i] = payload(t)
	}
	return TicketPage{Items: out, NextCursor: next}, nil
}

// own carrega o chamado e garante que pertence ao usuário (404 se não: não revela a existência).
func (s *Service) own(ctx context.Context, userID, id int64) (Ticket, error) {
	t, err := s.store.Get(ctx, id)
	if err != nil {
		return Ticket{}, err
	}
	if t.AuthorID != userID {
		return Ticket{}, ErrNotFound
	}
	return t.Ticket, nil
}

func (s *Service) detail(ctx context.Context, t Ticket, markRead bool) (TicketDetail, error) {
	msgs, err := s.store.Messages(ctx, t.ID, false) // o autor nunca recebe notas internas
	if err != nil {
		return TicketDetail{}, err
	}
	if markRead && t.UserUnread {
		if err := s.store.MarkRead(ctx, t.ID); err != nil {
			return TicketDetail{}, err
		}
		t.UserUnread = false
	}
	out := make([]TicketMessagePayload, 0, len(msgs))
	for _, m := range msgs {
		if m.Kind == MsgInternal {
			continue // defesa em profundidade: o store já filtra
		}
		out = append(out, TicketMessagePayload{ID: httpx.ID(m.ID), Kind: string(m.Kind), Body: m.Body, CreatedAt: m.CreatedAt})
	}
	return TicketDetail{TicketPayload: payload(t), Context: t.Context, Messages: out}, nil
}

// Get devolve o chamado do próprio usuário com a conversa e o marca como lido.
func (s *Service) Get(ctx context.Context, userID, id int64) (TicketDetail, error) {
	ctx, span := tracer.Start(ctx, "feedback.Get")
	defer span.End()
	t, err := s.own(ctx, userID, id)
	if err != nil {
		return TicketDetail{}, err
	}
	return s.detail(ctx, t, true)
}

// Reply registra uma resposta do autor. Chamado fechado exige reabrir antes; respondido/resolvido volta a "aberto".
func (s *Service) Reply(ctx context.Context, userID, id int64, body string) (TicketMessagePayload, error) {
	ctx, span := tracer.Start(ctx, "feedback.Reply")
	defer span.End()
	body, err := cleanBody(body)
	if err != nil {
		return TicketMessagePayload{}, err
	}
	if _, err := s.own(ctx, userID, id); err != nil {
		return TicketMessagePayload{}, err
	}
	m, t, err := s.store.AddMessage(ctx, NewMessage{
		ID: s.ids.Next(), TicketID: id, AuthorID: userID, Kind: MsgUser, Body: body,
		Decide: func(cur Ticket) (Decision, error) {
			if cur.AuthorID != userID {
				return Decision{}, ErrNotFound
			}
			if cur.Status == StatusClosed {
				return Decision{}, ErrClosed
			}
			next := cur.Status
			if next == StatusAnswered || next == StatusResolved {
				next = StatusOpen
			}
			return Decision{Touch: true, Status: next, Unread: cur.UserUnread}, nil
		},
	})
	if err != nil {
		return TicketMessagePayload{}, err
	}
	s.count(ctx, "reply")
	s.emit(t, false)
	return TicketMessagePayload{ID: httpx.ID(m.ID), Kind: string(m.Kind), Body: m.Body, CreatedAt: m.CreatedAt}, nil
}

// SetOwnStatus deixa o autor fechar o chamado ou reabri-lo (resolvido/fechado → aberto).
func (s *Service) SetOwnStatus(ctx context.Context, userID, id int64, status Status) (TicketPayload, error) {
	ctx, span := tracer.Start(ctx, "feedback.SetOwnStatus")
	defer span.End()
	if status != StatusOpen && status != StatusClosed {
		return TicketPayload{}, apperr.Invalid("você só pode fechar ou reabrir o chamado")
	}
	if _, err := s.own(ctx, userID, id); err != nil {
		return TicketPayload{}, err
	}
	t, err := s.store.SetStatus(ctx, id, func(cur Ticket) (Status, bool, error) {
		if cur.AuthorID != userID {
			return "", false, ErrNotFound
		}
		switch {
		case status == StatusClosed && cur.Status != StatusClosed:
			return StatusClosed, cur.UserUnread, nil
		case status == StatusOpen && (cur.Status == StatusResolved || cur.Status == StatusClosed):
			return StatusOpen, cur.UserUnread, nil
		}
		return "", false, ErrBadTransition
	})
	if err != nil {
		return TicketPayload{}, err
	}
	s.count(ctx, "status")
	s.emit(t, false)
	return payload(t), nil
}

// ---- administrador ----

// AdminList devolve a fila do administrador com filtros, busca, ordenação e cursor.
func (s *Service) AdminList(ctx context.Context, status, kind, q, sort, cursor string, limit int) (AdminTicketPage, error) {
	ctx, span := tracer.Start(ctx, "feedback.AdminList")
	defer span.End()
	f := AdminFilter{Sort: Sort(sort), Q: strings.TrimSpace(q)}
	if f.Sort == "" {
		f.Sort = SortActivity
	}
	if f.Sort != SortActivity && f.Sort != SortOldest {
		return AdminTicketPage{}, ErrInvalidSort
	}
	if status != "" {
		v := Status(status)
		if !v.valid() {
			return AdminTicketPage{}, ErrInvalidStatus
		}
		f.Status = &v
	}
	if kind != "" {
		v := Kind(kind)
		if !v.valid() {
			return AdminTicketPage{}, ErrInvalidKind
		}
		f.Kind = &v
	}
	if utf8.RuneCountInString(f.Q) > MaxQueryLen {
		f.Q = string([]rune(f.Q)[:MaxQueryLen])
	}
	after, err := parseCursor(cursor, f.Sort)
	if err != nil {
		return AdminTicketPage{}, err
	}
	limit = clampLimit(limit)
	rows, err := s.store.AdminList(ctx, f, after, limit+1)
	if err != nil {
		return AdminTicketPage{}, err
	}
	next := (*string)(nil)
	if len(rows) > limit {
		rows = rows[:limit]
		c := encodeCursor(rows[limit-1].Ticket, f.Sort)
		next = &c
	}
	out := make([]AdminTicketPayload, len(rows))
	for i, t := range rows {
		out[i] = adminPayload(t)
	}
	return AdminTicketPage{Items: out, NextCursor: next}, nil
}

func adminPayload(t AdminTicket) AdminTicketPayload {
	return AdminTicketPayload{
		TicketPayload: payload(t.Ticket),
		Author:        TicketAuthorPayload{ID: httpx.ID(t.Author.ID), Username: t.Author.Username, DisplayName: t.Author.DisplayName, Email: t.Author.Email},
	}
}

// TicketSummary devolve as contagens por estado.
func (s *Service) Summary(ctx context.Context) (TicketSummary, error) {
	ctx, span := tracer.Start(ctx, "feedback.Summary")
	defer span.End()
	return s.store.Counts(ctx)
}

// AdminGet devolve o chamado completo (notas internas e dados do autor).
func (s *Service) AdminGet(ctx context.Context, id int64) (AdminTicketDetail, error) {
	ctx, span := tracer.Start(ctx, "feedback.AdminGet")
	defer span.End()
	t, err := s.store.Get(ctx, id)
	if err != nil {
		return AdminTicketDetail{}, err
	}
	msgs, err := s.store.Messages(ctx, id, true)
	if err != nil {
		return AdminTicketDetail{}, err
	}
	out := make([]TicketAdminMessagePayload, len(msgs))
	for i, m := range msgs {
		out[i] = TicketAdminMessagePayload{ID: httpx.ID(m.ID), Kind: string(m.Kind), Body: m.Body, CreatedAt: m.CreatedAt, Username: m.AuthorUsername}
	}
	return AdminTicketDetail{AdminTicketPayload: adminPayload(t), Context: t.Context, Messages: out}, nil
}

// AdminReply grava uma resposta pública (avisa o autor e move para "respondido") ou uma nota interna (não muda nada).
func (s *Service) AdminReply(ctx context.Context, adminID, id int64, body string, internal bool) (TicketAdminMessagePayload, error) {
	ctx, span := tracer.Start(ctx, "feedback.AdminReply")
	defer span.End()
	body, err := cleanBody(body)
	if err != nil {
		return TicketAdminMessagePayload{}, err
	}
	kind := MsgAdmin
	if internal {
		kind = MsgInternal
	}
	m, t, err := s.store.AddMessage(ctx, NewMessage{
		ID: s.ids.Next(), TicketID: id, AuthorID: adminID, Kind: kind, Body: body,
		Decide: func(cur Ticket) (Decision, error) {
			if internal {
				return Decision{}, nil
			}
			if cur.Status == StatusClosed {
				return Decision{}, ErrClosed
			}
			next := cur.Status
			if next == StatusOpen || next == StatusInReview {
				next = StatusAnswered
			}
			return Decision{Touch: true, Status: next, Unread: true}, nil
		},
	})
	if err != nil {
		return TicketAdminMessagePayload{}, err
	}
	span.SetAttributes(attribute.String("ticket.id", httpx.ID(id)), attribute.Bool("ticket.internal", internal))
	slog.InfoContext(ctx, "chamado respondido pela equipe", "ticket_id", id, "admin_id", adminID, "internal", internal)
	if internal {
		s.count(ctx, "note")
	} else {
		s.count(ctx, "admin_reply")
		s.emit(t, true)
	}
	return TicketAdminMessagePayload{ID: httpx.ID(m.ID), Kind: string(m.Kind), Body: m.Body, CreatedAt: m.CreatedAt}, nil
}

// AdminSetStatus muda o estado para qualquer um dos cinco. Resolver ou fechar marca "não lido" para o autor.
func (s *Service) AdminSetStatus(ctx context.Context, adminID, id int64, status Status) (AdminTicketPayload, error) {
	ctx, span := tracer.Start(ctx, "feedback.AdminSetStatus")
	defer span.End()
	if !status.valid() {
		return AdminTicketPayload{}, ErrInvalidStatus
	}
	t, err := s.store.SetStatus(ctx, id, func(cur Ticket) (Status, bool, error) {
		if cur.Status == status {
			return status, cur.UserUnread, nil
		}
		return status, cur.UserUnread || status == StatusResolved || status == StatusClosed, nil
	})
	if err != nil {
		return AdminTicketPayload{}, err
	}
	s.count(ctx, "status")
	slog.InfoContext(ctx, "estado do chamado alterado pela equipe", "ticket_id", id, "admin_id", adminID, "status", string(status))
	s.emit(t, true)
	full, err := s.store.Get(ctx, id)
	if err != nil {
		return AdminTicketPayload{}, err
	}
	return adminPayload(full), nil
}

// ---- paginação ----

func clampLimit(n int) int {
	switch {
	case n <= 0:
		return DefaultPageSize
	case n > MaxPageSize:
		return MaxPageSize
	}
	return n
}

// encodeCursor: "<microssegundos>.<id>" na ordenação por atividade; só "<id>" em "oldest".
func encodeCursor(t Ticket, sort Sort) string {
	if sort == SortOldest {
		return strconv.FormatInt(t.ID, 10)
	}
	return fmt.Sprintf("%d.%d", t.LastActivityAt.UnixMicro(), t.ID)
}

func parseCursor(s string, sort Sort) (*Cursor, error) {
	if s == "" {
		return nil, nil
	}
	if sort == SortOldest {
		id, err := strconv.ParseInt(s, 10, 64)
		if err != nil || id <= 0 {
			return nil, ErrInvalidCursor
		}
		return &Cursor{ID: id}, nil
	}
	a, b, ok := strings.Cut(s, ".")
	if !ok {
		return nil, ErrInvalidCursor
	}
	us, err1 := strconv.ParseInt(a, 10, 64)
	id, err2 := strconv.ParseInt(b, 10, 64)
	if err1 != nil || err2 != nil || id <= 0 {
		return nil, ErrInvalidCursor
	}
	return &Cursor{At: time.UnixMicro(us).UTC(), ID: id}, nil
}
