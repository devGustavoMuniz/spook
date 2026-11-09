package feedback

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/metric"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

// Anexos dos chamados: capturas de tela (PNG, JPEG ou WebP). A validação de tipo, extensão, nome e conteúdo
// (magic bytes) é a do upload de mensagens (pacote attachment); aqui ficam só o que é próprio dos chamados:
// limites menores, a chave do objeto (tickets/<chamado>/<id>.<ext>) e a autorização pelo autor ou admin.
const (
	MaxAttachmentBytes      = 5 << 20 // por imagem
	MaxAttachmentsPerMsg    = 3       // imagens por mensagem
	MaxAttachmentsPerTicket = 30      // imagens ligadas a mensagens de um mesmo chamado
	MaxPendingAttachments   = 10      // pedidos de upload ainda não enviados em mensagem, por usuário

	AttachmentUploadTTL   = 5 * time.Minute  // validade da URL de PUT
	AttachmentReadTTL     = 15 * time.Minute // validade das URLs de leitura entregues na conversa
	AttachmentClaimWindow = time.Hour        // quanto um anexo pode esperar a mensagem antes de virar órfão
)

var (
	ErrUploadsDisabled     = attachment.ErrUploadsDisabled
	ErrInvalidAttachments  = apperr.Invalid("anexo inválido, de outro usuário, de outro chamado ou expirado")
	ErrTooManyAttachments  = apperr.Invalid("no máximo 3 imagens por mensagem")
	ErrTicketAttachLimit   = apperr.Conflict("este chamado atingiu o limite de 30 imagens")
	ErrTooManyPendingFiles = apperr.Conflict("muitas imagens pendentes; envie a mensagem ou espere expirarem")
	ErrImageOnly           = apperr.Invalid("anexe apenas imagens PNG, JPEG ou WebP")
)

// attachmentExt mapeia os tipos aceitos nos chamados para a extensão da chave do objeto.
var attachmentExt = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}

// Attachment é uma linha de ticket_attachments.
type Attachment struct {
	ID          int64
	TicketID    int64
	MessageID   *int64
	UploaderID  int64
	ObjectKey   string
	Filename    string
	ContentType string
	Size        int64
	CreatedAt   time.Time
}

// Claim são os anexos a ligar à mensagem que está sendo gravada (dentro da mesma transação).
type Claim struct {
	IDs        []int64
	UploaderID int64
	Since      time.Time
}

// Objects é o storage S3 genérico (nada específico do Garage).
type Objects interface {
	PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	Stat(ctx context.Context, key string) (storage.ObjectInfo, error)
	GetRange(ctx context.Context, key string, offset, length int64) ([]byte, error)
	Delete(ctx context.Context, key string) error
}

// Attach são os anexos citados ao abrir ou responder um chamado (IDs em string, como trafegam na API).
type Attach struct {
	DraftID string   // só na abertura: ID reservado pelo primeiro pedido de upload (vira o ID do chamado)
	IDs     []string // anexos já enviados ao storage
}

// TicketAttachmentPayload é uma imagem anexada a uma mensagem do chamado.
type TicketAttachmentPayload struct {
	ID          string `json:"id"`
	Filename    string `json:"filename"`
	ContentType string `json:"content_type"`
	Size        int64  `json:"size"`
	URL         string `json:"url" doc:"GET pré-assinado, válido por 15 min (a conversa é recarregada ao abrir)"`
}

// TicketUploadPayload é a resposta do pedido de upload.
type TicketUploadPayload struct {
	ID        string            `json:"id" doc:"Use em attachment_ids ao abrir o chamado ou responder"`
	TicketID  string            `json:"ticket_id" doc:"Chamado do anexo. Em um chamado novo é o ID reservado (rascunho): reenvie em ticket_id nos próximos uploads e em draft_id ao criar"`
	UploadURL string            `json:"upload_url" doc:"PUT pré-assinado; envie o arquivo cru como corpo"`
	Headers   map[string]string `json:"headers" doc:"Cabeçalhos que o PUT precisa enviar exatamente assim"`
	ExpiresIn int               `json:"expires_in" doc:"Segundos até a URL de PUT expirar"`
}

func (s *Service) reject(ctx context.Context, reason string) {
	s.attachments.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "rejected"), attribute.String("reason", reason)))
}

// canAccess diz se o usuário pode anexar ao chamado: o autor ou um administrador.
func (s *Service) canAccess(ctx context.Context, userID int64, t Ticket) (bool, error) {
	if t.AuthorID == userID {
		return true, nil
	}
	return s.admins.IsAdmin(ctx, userID)
}

// RequestUpload cria o anexo pendente e devolve a URL de PUT. ticketID vazio = chamado novo: o servidor reserva o ID
// do chamado e o devolve para os próximos arquivos. Autorização: autor do chamado ou administrador; quem não pode
// recebe 404 (não revela a existência do chamado).
func (s *Service) RequestUpload(ctx context.Context, userID int64, ticketID, filename, contentType string, size int64) (TicketUploadPayload, error) {
	ctx, span := tracer.Start(ctx, "feedback.RequestUpload")
	defer span.End()
	span.SetAttributes(attribute.Int64("upload.size", size), attribute.String("upload.content_type", contentType))
	if s.objects == nil {
		return TicketUploadPayload{}, ErrUploadsDisabled
	}
	if _, ok := attachmentExt[contentType]; !ok {
		s.reject(ctx, "type")
		return TicketUploadPayload{}, ErrImageOnly
	}
	name, err := attachment.ValidateUploadMax(filename, contentType, size, MaxAttachmentBytes)
	if err != nil {
		s.reject(ctx, "invalid")
		return TicketUploadPayload{}, err
	}
	since := s.now().Add(-AttachmentClaimWindow)

	var tid int64
	if ticketID == "" {
		tid = s.ids.Next() // rascunho: o primeiro arquivo reserva o ID
	} else {
		id, ok := httpx.ParseID(ticketID)
		if !ok {
			return TicketUploadPayload{}, httpx.BadID("chamado")
		}
		tid = id
		t, err := s.store.Get(ctx, id)
		switch {
		case err == nil:
			ok, aerr := s.canAccess(ctx, userID, t.Ticket)
			if aerr != nil {
				return TicketUploadPayload{}, aerr
			}
			if !ok {
				return TicketUploadPayload{}, ErrNotFound
			}
		case errors.Is(err, ErrNotFound):
			// Não existe: só vale como rascunho do próprio usuário (já tem anexo pendente com esse ID).
			n, cerr := s.store.CountPendingFor(ctx, userID, id, since)
			if cerr != nil {
				return TicketUploadPayload{}, cerr
			}
			if n == 0 {
				return TicketUploadPayload{}, ErrNotFound
			}
		default:
			return TicketUploadPayload{}, err
		}
	}
	pending, err := s.store.CountPending(ctx, userID, since)
	if err != nil {
		return TicketUploadPayload{}, err
	}
	if pending >= MaxPendingAttachments {
		s.reject(ctx, "too_many_pending")
		return TicketUploadPayload{}, ErrTooManyPendingFiles
	}

	id := s.ids.Next()
	key := "tickets/" + httpx.ID(tid) + "/" + httpx.ID(id) + "." + attachmentExt[contentType]
	if err := s.store.InsertAttachment(ctx, Attachment{ID: id, TicketID: tid, UploaderID: userID, ObjectKey: key, Filename: name, ContentType: contentType, Size: size}); err != nil {
		return TicketUploadPayload{}, err
	}
	url, err := s.objects.PresignPut(ctx, key, contentType, size, AttachmentUploadTTL)
	if err != nil {
		return TicketUploadPayload{}, err
	}
	s.attachments.Add(ctx, 1, metric.WithAttributes(attribute.String("result", "requested")))
	return TicketUploadPayload{
		ID: httpx.ID(id), TicketID: httpx.ID(tid), UploadURL: url,
		Headers: map[string]string{"Content-Type": contentType}, ExpiresIn: int(AttachmentUploadTTL.Seconds()),
	}, nil
}

// parseAttach valida a lista de IDs (máximo por mensagem, sem repetidos) e o rascunho.
func parseAttach(a Attach) (ids []int64, draft int64, err error) {
	if len(a.IDs) > MaxAttachmentsPerMsg {
		return nil, 0, ErrTooManyAttachments
	}
	seen := map[int64]bool{}
	for _, raw := range a.IDs {
		id, ok := httpx.ParseID(raw)
		if !ok || seen[id] {
			return nil, 0, ErrInvalidAttachments
		}
		seen[id] = true
		ids = append(ids, id)
	}
	if a.DraftID != "" {
		d, ok := httpx.ParseID(a.DraftID)
		if !ok {
			return nil, 0, ErrInvalidAttachments
		}
		draft = d
	}
	return ids, draft, nil
}

// verify confere se os anexos podem entrar numa mensagem do chamado: são do usuário, do chamado, livres e recentes;
// o objeto existe com o tamanho declarado; e os primeiros bytes batem com o tipo. Divergência apaga o objeto.
func (s *Service) verify(ctx context.Context, userID, ticketID int64, ids []int64) (Claim, error) {
	ctx, span := tracer.Start(ctx, "feedback.VerifyAttachments")
	defer span.End()
	span.SetAttributes(attribute.Int("attachments.count", len(ids)))
	if s.objects == nil {
		return Claim{}, ErrUploadsDisabled
	}
	since := s.now().Add(-AttachmentClaimWindow)
	rows, err := s.store.Pending(ctx, ids, userID, ticketID, since)
	if err != nil {
		return Claim{}, err
	}
	if len(rows) != len(ids) {
		s.reject(ctx, "not_claimable")
		return Claim{}, ErrInvalidAttachments
	}
	for _, a := range rows {
		if err := s.verifyObject(ctx, a); err != nil {
			return Claim{}, err
		}
	}
	return Claim{IDs: ids, UploaderID: userID, Since: since}, nil
}

func (s *Service) verifyObject(ctx context.Context, a Attachment) error {
	info, err := s.objects.Stat(ctx, a.ObjectKey)
	if errors.Is(err, storage.ErrNotFound) {
		s.reject(ctx, "not_uploaded")
		return apperr.Invalid(fmt.Sprintf("a imagem %q ainda não foi enviada ao storage", a.Filename))
	}
	if err != nil {
		return err
	}
	if info.Size != a.Size {
		s.discard(ctx, a)
		s.reject(ctx, "size_mismatch")
		return apperr.Invalid(fmt.Sprintf("o tamanho de %q não confere com o declarado", a.Filename))
	}
	head, err := s.objects.GetRange(ctx, a.ObjectKey, 0, attachment.SniffLen)
	if err != nil {
		return err
	}
	if !attachment.MatchesContent(a.ContentType, head) {
		s.discard(ctx, a)
		s.reject(ctx, "content_mismatch")
		return apperr.Invalid(fmt.Sprintf("o conteúdo de %q não corresponde ao tipo %s", a.Filename, a.ContentType))
	}
	return nil
}

// discard apaga o objeto e a linha de um anexo recusado (melhor esforço).
func (s *Service) discard(ctx context.Context, a Attachment) {
	ctx = context.WithoutCancel(ctx)
	if err := s.objects.Delete(ctx, a.ObjectKey); err != nil {
		slog.Warn("apagar objeto de chamado recusado", "key", a.ObjectKey, "err", err)
	}
	if err := s.store.DeletePending(ctx, []int64{a.ID}); err != nil {
		slog.Warn("apagar anexo de chamado recusado", "id", a.ID, "err", err)
	}
}

// attachmentPayloads monta as imagens de um conjunto de anexos com as URLs de leitura curtas.
func (s *Service) attachmentPayloads(ctx context.Context, as []Attachment) ([]TicketAttachmentPayload, error) {
	out := make([]TicketAttachmentPayload, 0, len(as))
	for _, a := range as {
		url, err := s.objects.PresignGet(ctx, a.ObjectKey, AttachmentReadTTL)
		if err != nil {
			return nil, err
		}
		out = append(out, TicketAttachmentPayload{ID: httpx.ID(a.ID), Filename: a.Filename, ContentType: a.ContentType, Size: a.Size, URL: url})
	}
	return out, nil
}

// attachmentsByMessage devolve os anexos do chamado agrupados por mensagem (uma consulta só, sem N+1).
func (s *Service) attachmentsByMessage(ctx context.Context, ticketID int64) (map[int64][]Attachment, error) {
	if s.objects == nil {
		return nil, nil
	}
	rows, err := s.store.Attachments(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	out := make(map[int64][]Attachment, len(rows))
	for _, a := range rows {
		if a.MessageID != nil {
			out[*a.MessageID] = append(out[*a.MessageID], a)
		}
	}
	return out, nil
}

// messageAttachments devolve as imagens de uma mensagem recém-gravada.
func (s *Service) messageAttachments(ctx context.Context, ticketID, messageID int64) ([]TicketAttachmentPayload, error) {
	by, err := s.attachmentsByMessage(ctx, ticketID)
	if err != nil {
		return nil, err
	}
	return s.attachmentPayloads(ctx, by[messageID])
}

// CleanupOrphans apaga os anexos sem mensagem há mais de AttachmentClaimWindow (linha e objeto). Devolve quantos.
func (s *Service) CleanupOrphans(ctx context.Context) (int, error) {
	ctx, span := tracer.Start(ctx, "feedback.CleanupOrphans")
	defer span.End()
	if s.objects == nil {
		return 0, nil
	}
	total := 0
	for {
		rows, err := s.store.Orphans(ctx, s.now().Add(-AttachmentClaimWindow), 100)
		if err != nil {
			return total, err
		}
		if len(rows) == 0 {
			break
		}
		ids := make([]int64, 0, len(rows))
		for _, a := range rows {
			if err := s.objects.Delete(ctx, a.ObjectKey); err != nil {
				return total, err
			}
			ids = append(ids, a.ID)
		}
		if err := s.store.DeletePending(ctx, ids); err != nil {
			return total, err
		}
		total += len(rows)
		if len(rows) < 100 {
			break
		}
	}
	span.SetAttributes(attribute.Int("orphans.deleted", total))
	if total > 0 {
		s.attachments.Add(ctx, int64(total), metric.WithAttributes(attribute.String("result", "orphan_deleted")))
		slog.Info("anexos de chamados órfãos apagados", "count", total)
	}
	return total, nil
}
