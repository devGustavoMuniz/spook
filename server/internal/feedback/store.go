package feedback

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// PGStore implementa Store sobre o Postgres.
type PGStore struct {
	db db.DB
	q  *dbgen.Queries
}

func NewStore(d db.DB) *PGStore { return &PGStore{db: d, q: dbgen.New(d)} }

func wrap(op string, err error) error { return fmt.Errorf("%s: %w", op, err) }

func ts(t pgtype.Timestamptz) time.Time { return t.Time }

func toTicket(r dbgen.Ticket) Ticket {
	t := Ticket{
		ID: r.ID, AuthorID: r.AuthorID, Kind: Kind(r.Kind), Status: Status(r.Status), Title: r.Title,
		MessageCount: int(r.MessageCount), UserUnread: r.UserUnread,
		CreatedAt: ts(r.CreatedAt), UpdatedAt: ts(r.UpdatedAt), LastActivityAt: ts(r.LastActivityAt),
	}
	if len(r.Context) > 0 {
		var c TicketContext
		if json.Unmarshal(r.Context, &c) == nil {
			t.Context = &c
		}
	}
	return t
}

func name(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func cursorArgs(after *Cursor, withTime bool) (*int64, pgtype.Timestamptz) {
	if after == nil {
		return nil, pgtype.Timestamptz{}
	}
	id := after.ID
	if !withTime {
		return &id, pgtype.Timestamptz{}
	}
	return &id, pgtype.Timestamptz{Time: after.At, Valid: true}
}

func (s *PGStore) Create(ctx context.Context, n NewTicket) (Ticket, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Ticket{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	var raw []byte
	if n.Context != nil {
		if raw, err = json.Marshal(n.Context); err != nil {
			return Ticket{}, wrap("serializar contexto", err)
		}
	}
	row, err := q.InsertTicket(ctx, dbgen.InsertTicketParams{ID: n.ID, AuthorID: n.AuthorID, Kind: string(n.Kind), Title: n.Title, Context: raw})
	if err != nil {
		return Ticket{}, wrap("inserir chamado", err)
	}
	author := n.AuthorID
	if _, err := q.InsertTicketMessage(ctx, dbgen.InsertTicketMessageParams{
		ID: n.MessageID, TicketID: n.ID, AuthorID: &author, Kind: string(MsgUser), Body: n.Body,
	}); err != nil {
		return Ticket{}, wrap("inserir mensagem", err)
	}
	if err := claim(ctx, q, n.Claim, n.ID, n.MessageID); err != nil {
		return Ticket{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, wrap("confirmar", err)
	}
	return toTicket(row), nil
}

// claim liga os anexos à mensagem recém-inserida. Anexo que sumiu, é de outro ou já foi usado desfaz a transação.
func claim(ctx context.Context, q *dbgen.Queries, c *Claim, ticketID, messageID int64) error {
	if c == nil || len(c.IDs) == 0 {
		return nil
	}
	n, err := q.CountTicketAttachments(ctx, ticketID)
	if err != nil {
		return wrap("contar anexos", err)
	}
	if int(n)+len(c.IDs) > MaxAttachmentsPerTicket {
		return ErrTicketAttachLimit
	}
	rows, err := q.ClaimTicketAttachments(ctx, dbgen.ClaimTicketAttachmentsParams{
		MessageID: &messageID, Ids: c.IDs, UploaderID: c.UploaderID, TicketID: ticketID, Since: pgtype.Timestamptz{Time: c.Since, Valid: true},
	})
	if err != nil {
		return wrap("ligar anexos", err)
	}
	if len(rows) != len(c.IDs) {
		return ErrInvalidAttachments
	}
	return nil
}

func toAttachment(r dbgen.TicketAttachment) Attachment {
	return Attachment{
		ID: r.ID, TicketID: r.TicketID, MessageID: r.MessageID, UploaderID: r.UploaderID, ObjectKey: r.ObjectKey,
		Filename: r.Filename, ContentType: r.ContentType, Size: r.SizeBytes, CreatedAt: ts(r.CreatedAt),
	}
}

func toAttachments(rs []dbgen.TicketAttachment) []Attachment {
	out := make([]Attachment, len(rs))
	for i, r := range rs {
		out[i] = toAttachment(r)
	}
	return out
}

func tsv(t time.Time) pgtype.Timestamptz { return pgtype.Timestamptz{Time: t, Valid: true} }

func (s *PGStore) InsertAttachment(ctx context.Context, a Attachment) error {
	err := s.q.InsertTicketAttachment(ctx, dbgen.InsertTicketAttachmentParams{
		ID: a.ID, TicketID: a.TicketID, UploaderID: a.UploaderID, ObjectKey: a.ObjectKey, Filename: a.Filename, ContentType: a.ContentType, SizeBytes: a.Size,
	})
	if err != nil {
		return wrap("gravar anexo", err)
	}
	return nil
}

func (s *PGStore) CountPending(ctx context.Context, uploaderID int64, since time.Time) (int, error) {
	n, err := s.q.CountPendingTicketAttachments(ctx, dbgen.CountPendingTicketAttachmentsParams{UploaderID: uploaderID, Since: tsv(since)})
	if err != nil {
		return 0, wrap("contar anexos pendentes", err)
	}
	return int(n), nil
}

func (s *PGStore) CountPendingFor(ctx context.Context, uploaderID, ticketID int64, since time.Time) (int, error) {
	n, err := s.q.CountPendingTicketAttachmentsForTicket(ctx, dbgen.CountPendingTicketAttachmentsForTicketParams{UploaderID: uploaderID, TicketID: ticketID, Since: tsv(since)})
	if err != nil {
		return 0, wrap("contar anexos do rascunho", err)
	}
	return int(n), nil
}

func (s *PGStore) Pending(ctx context.Context, ids []int64, uploaderID, ticketID int64, since time.Time) ([]Attachment, error) {
	rs, err := s.q.ListPendingTicketAttachments(ctx, dbgen.ListPendingTicketAttachmentsParams{Ids: ids, UploaderID: uploaderID, TicketID: ticketID, Since: tsv(since)})
	if err != nil {
		return nil, wrap("buscar anexos pendentes", err)
	}
	return toAttachments(rs), nil
}

func (s *PGStore) Attachments(ctx context.Context, ticketID int64) ([]Attachment, error) {
	rs, err := s.q.ListTicketAttachments(ctx, ticketID)
	if err != nil {
		return nil, wrap("listar anexos", err)
	}
	return toAttachments(rs), nil
}

func (s *PGStore) Orphans(ctx context.Context, before time.Time, limit int) ([]Attachment, error) {
	rs, err := s.q.ListOrphanTicketAttachments(ctx, dbgen.ListOrphanTicketAttachmentsParams{Before: tsv(before), MaxRows: int32(limit)})
	if err != nil {
		return nil, wrap("listar anexos órfãos", err)
	}
	return toAttachments(rs), nil
}

// DeletePending apaga as linhas ainda sem mensagem.
func (s *PGStore) DeletePending(ctx context.Context, ids []int64) error {
	if _, err := s.q.DeleteTicketAttachments(ctx, ids); err != nil {
		return wrap("apagar anexos", err)
	}
	return nil
}

func (s *PGStore) ActiveCount(ctx context.Context, authorID int64) (int64, error) {
	n, err := s.q.CountActiveTicketsByAuthor(ctx, authorID)
	if err != nil {
		return 0, wrap("contar chamados", err)
	}
	return n, nil
}

func (s *PGStore) ListByAuthor(ctx context.Context, authorID int64, status *Status, after *Cursor, limit int) ([]Ticket, error) {
	id, at := cursorArgs(after, true)
	var st *string
	if status != nil {
		v := string(*status)
		st = &v
	}
	rows, err := s.q.ListTicketsByAuthor(ctx, dbgen.ListTicketsByAuthorParams{
		AuthorID: authorID, Status: st, AfterID: id, AfterAt: at, MaxRows: int32(limit),
	})
	if err != nil {
		return nil, wrap("listar chamados", err)
	}
	out := make([]Ticket, len(rows))
	for i, r := range rows {
		out[i] = toTicket(r)
	}
	return out, nil
}

func (s *PGStore) Get(ctx context.Context, id int64) (AdminTicket, error) {
	r, err := s.q.AdminGetTicket(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return AdminTicket{}, ErrNotFound
	}
	if err != nil {
		return AdminTicket{}, wrap("buscar chamado", err)
	}
	return toAdmin(dbgen.Ticket{
		ID: r.ID, AuthorID: r.AuthorID, Kind: r.Kind, Status: r.Status, Title: r.Title, Context: r.Context, MessageCount: r.MessageCount,
		UserUnread: r.UserUnread, CreatedAt: r.CreatedAt, UpdatedAt: r.UpdatedAt, LastActivityAt: r.LastActivityAt,
	}, r.AuthorUsername, r.AuthorDisplayName, r.AuthorEmail), nil
}

func toAdmin(t dbgen.Ticket, username string, display *string, email string) AdminTicket {
	return AdminTicket{Ticket: toTicket(t), Author: Author{ID: t.AuthorID, Username: username, DisplayName: name(display), Email: email}}
}

func (s *PGStore) Messages(ctx context.Context, ticketID int64, includeInternal bool) ([]Message, error) {
	rows, err := s.q.ListTicketMessages(ctx, dbgen.ListTicketMessagesParams{TicketID: ticketID, IncludeInternal: includeInternal})
	if err != nil {
		return nil, wrap("listar mensagens", err)
	}
	out := make([]Message, len(rows))
	for i, r := range rows {
		out[i] = Message{
			ID: r.ID, TicketID: r.TicketID, AuthorID: r.AuthorID, Kind: MessageKind(r.Kind), Body: r.Body, CreatedAt: ts(r.CreatedAt),
			AuthorUsername: r.AuthorUsername, AuthorDisplayName: name(r.AuthorDisplayName),
		}
	}
	return out, nil
}

func (s *PGStore) AddMessage(ctx context.Context, m NewMessage) (Message, Ticket, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Message{}, Ticket{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	cur, err := q.GetTicketForUpdate(ctx, m.TicketID)
	if errors.Is(err, pgx.ErrNoRows) {
		return Message{}, Ticket{}, ErrNotFound
	}
	if err != nil {
		return Message{}, Ticket{}, wrap("travar chamado", err)
	}
	ticket := toTicket(cur)
	if m.Kind == MsgInternal {
		n, err := q.CountInternalTicketMessages(ctx, m.TicketID)
		if err != nil {
			return Message{}, Ticket{}, wrap("contar notas", err)
		}
		if n >= MaxInternalNotes {
			return Message{}, Ticket{}, ErrTooManyNotes
		}
	} else if ticket.MessageCount >= MaxPublicMessages {
		return Message{}, Ticket{}, ErrTooManyMessages
	}
	dec, err := m.Decide(ticket)
	if err != nil {
		return Message{}, Ticket{}, err
	}
	author := m.AuthorID
	row, err := q.InsertTicketMessage(ctx, dbgen.InsertTicketMessageParams{
		ID: m.ID, TicketID: m.TicketID, AuthorID: &author, Kind: string(m.Kind), Body: m.Body,
	})
	if err != nil {
		return Message{}, Ticket{}, wrap("inserir mensagem", err)
	}
	if err := claim(ctx, q, m.Claim, m.TicketID, m.ID); err != nil {
		return Message{}, Ticket{}, err
	}
	if dec.Touch {
		upd, err := q.UpdateTicketActivity(ctx, dbgen.UpdateTicketActivityParams{
			ID: m.TicketID, Status: string(dec.Status), UserUnread: dec.Unread, Added: 1,
		})
		if err != nil {
			return Message{}, Ticket{}, wrap("atualizar chamado", err)
		}
		ticket = toTicket(upd)
	}
	if err := tx.Commit(ctx); err != nil {
		return Message{}, Ticket{}, wrap("confirmar", err)
	}
	return Message{ID: row.ID, TicketID: row.TicketID, AuthorID: row.AuthorID, Kind: MessageKind(row.Kind), Body: row.Body, CreatedAt: ts(row.CreatedAt)}, ticket, nil
}

func (s *PGStore) SetStatus(ctx context.Context, id int64, decide func(cur Ticket) (Status, bool, error)) (Ticket, error) {
	tx, err := s.db.Begin(ctx)
	if err != nil {
		return Ticket{}, wrap("iniciar transação", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := s.q.WithTx(tx)
	cur, err := q.GetTicketForUpdate(ctx, id)
	if errors.Is(err, pgx.ErrNoRows) {
		return Ticket{}, ErrNotFound
	}
	if err != nil {
		return Ticket{}, wrap("travar chamado", err)
	}
	st, unread, err := decide(toTicket(cur))
	if err != nil {
		return Ticket{}, err
	}
	upd, err := q.UpdateTicketActivity(ctx, dbgen.UpdateTicketActivityParams{ID: id, Status: string(st), UserUnread: unread})
	if err != nil {
		return Ticket{}, wrap("atualizar estado", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return Ticket{}, wrap("confirmar", err)
	}
	return toTicket(upd), nil
}

func (s *PGStore) MarkRead(ctx context.Context, id int64) error {
	if err := s.q.MarkTicketRead(ctx, id); err != nil {
		return wrap("marcar como lido", err)
	}
	return nil
}

// likeEscape escapa os curingas do LIKE para a busca literal.
func likeEscape(q string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(q)
}

func (s *PGStore) AdminList(ctx context.Context, f AdminFilter, after *Cursor, limit int) ([]AdminTicket, error) {
	var st, kind, q *string
	if f.Status != nil {
		v := string(*f.Status)
		st = &v
	}
	if f.Kind != nil {
		v := string(*f.Kind)
		kind = &v
	}
	if f.Q != "" {
		v := likeEscape(f.Q)
		q = &v
	}
	out := []AdminTicket{}
	if f.Sort == SortOldest {
		id, _ := cursorArgs(after, false)
		rows, err := s.q.AdminListTicketsOldest(ctx, dbgen.AdminListTicketsOldestParams{Status: st, Kind: kind, Q: q, AfterID: id, MaxRows: int32(limit)})
		if err != nil {
			return nil, wrap("listar fila", err)
		}
		for _, r := range rows {
			out = append(out, toAdmin(rowTicket(r.ID, r.AuthorID, r.Kind, r.Status, r.Title, r.Context, r.MessageCount, r.UserUnread, r.CreatedAt, r.UpdatedAt, r.LastActivityAt),
				r.AuthorUsername, r.AuthorDisplayName, r.AuthorEmail))
		}
		return out, nil
	}
	id, at := cursorArgs(after, true)
	rows, err := s.q.AdminListTicketsByActivity(ctx, dbgen.AdminListTicketsByActivityParams{Status: st, Kind: kind, Q: q, AfterID: id, AfterAt: at, MaxRows: int32(limit)})
	if err != nil {
		return nil, wrap("listar fila", err)
	}
	for _, r := range rows {
		out = append(out, toAdmin(rowTicket(r.ID, r.AuthorID, r.Kind, r.Status, r.Title, r.Context, r.MessageCount, r.UserUnread, r.CreatedAt, r.UpdatedAt, r.LastActivityAt),
			r.AuthorUsername, r.AuthorDisplayName, r.AuthorEmail))
	}
	return out, nil
}

func rowTicket(id, author int64, kind, status, title string, ctxJSON []byte, count int32, unread bool, created, updated, activity pgtype.Timestamptz) dbgen.Ticket {
	return dbgen.Ticket{
		ID: id, AuthorID: author, Kind: kind, Status: status, Title: title, Context: ctxJSON, MessageCount: count,
		UserUnread: unread, CreatedAt: created, UpdatedAt: updated, LastActivityAt: activity,
	}
}

func (s *PGStore) Counts(ctx context.Context) (TicketSummary, error) {
	rows, err := s.q.AdminTicketCounts(ctx)
	if err != nil {
		return TicketSummary{}, wrap("contar chamados", err)
	}
	var sum TicketSummary
	for _, r := range rows {
		switch Status(r.Status) {
		case StatusOpen:
			sum.Open = r.Total
		case StatusInReview:
			sum.InReview = r.Total
		case StatusAnswered:
			sum.Answered = r.Total
		case StatusResolved:
			sum.Resolved = r.Total
		case StatusClosed:
			sum.Closed = r.Total
		}
		sum.Total += r.Total
	}
	return sum, nil
}
