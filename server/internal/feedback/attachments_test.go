package feedback

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

// ---- fakes dos anexos ----

func (f *fakeStore) claim(c *Claim, ticketID, messageID int64) error {
	if c == nil || len(c.IDs) == 0 {
		return nil
	}
	attached := 0
	for _, a := range f.atts {
		if a.TicketID == ticketID && a.MessageID != nil {
			attached++
		}
	}
	if attached+len(c.IDs) > MaxAttachmentsPerTicket {
		return ErrTicketAttachLimit
	}
	var rows []*Attachment
	for _, id := range c.IDs {
		a, ok := f.atts[id]
		if ok && a.UploaderID == c.UploaderID && a.TicketID == ticketID && a.MessageID == nil && a.CreatedAt.After(c.Since) {
			rows = append(rows, a)
		}
	}
	if len(rows) != len(c.IDs) {
		return ErrInvalidAttachments
	}
	for _, a := range rows {
		a.MessageID = &messageID
	}
	return nil
}

func (f *fakeStore) InsertAttachment(_ context.Context, a Attachment) error {
	a.CreatedAt = time.Now()
	f.atts[a.ID] = &a
	return nil
}

func (f *fakeStore) CountPending(_ context.Context, uploader int64, since time.Time) (int, error) {
	n := 0
	for _, a := range f.atts {
		if a.UploaderID == uploader && a.MessageID == nil && a.CreatedAt.After(since) {
			n++
		}
	}
	return n, nil
}

func (f *fakeStore) CountPendingFor(_ context.Context, uploader, ticketID int64, since time.Time) (int, error) {
	n := 0
	for _, a := range f.atts {
		if a.UploaderID == uploader && a.TicketID == ticketID && a.MessageID == nil && a.CreatedAt.After(since) {
			n++
		}
	}
	return n, nil
}

func (f *fakeStore) Pending(_ context.Context, ids []int64, uploader, ticketID int64, since time.Time) ([]Attachment, error) {
	var out []Attachment
	for _, id := range ids {
		if a, ok := f.atts[id]; ok && a.UploaderID == uploader && a.TicketID == ticketID && a.MessageID == nil && a.CreatedAt.After(since) {
			out = append(out, *a)
		}
	}
	return out, nil
}

func (f *fakeStore) Attachments(_ context.Context, ticketID int64) ([]Attachment, error) {
	var out []Attachment
	for _, a := range f.atts {
		if a.TicketID == ticketID && a.MessageID != nil {
			out = append(out, *a)
		}
	}
	return out, nil
}

func (f *fakeStore) Orphans(_ context.Context, before time.Time, limit int) ([]Attachment, error) {
	var out []Attachment
	for _, a := range f.atts {
		if a.MessageID == nil && a.CreatedAt.Before(before) && len(out) < limit {
			out = append(out, *a)
		}
	}
	return out, nil
}

func (f *fakeStore) DeletePending(_ context.Context, ids []int64) error {
	for _, id := range ids {
		if a, ok := f.atts[id]; ok && a.MessageID == nil {
			delete(f.atts, id)
		}
	}
	return nil
}

type fakeObjects struct {
	data map[string][]byte
	ttl  time.Duration
}

func (o *fakeObjects) PresignPut(_ context.Context, key, _ string, _ int64, _ time.Duration) (string, error) {
	return "http://put/" + key, nil
}

func (o *fakeObjects) PresignGet(_ context.Context, key string, ttl time.Duration) (string, error) {
	o.ttl = ttl
	return "http://get/" + key, nil
}

func (o *fakeObjects) Stat(_ context.Context, key string) (storage.ObjectInfo, error) {
	b, ok := o.data[key]
	if !ok {
		return storage.ObjectInfo{}, storage.ErrNotFound
	}
	return storage.ObjectInfo{Size: int64(len(b))}, nil
}

func (o *fakeObjects) GetRange(_ context.Context, key string, off, n int64) ([]byte, error) {
	b := o.data[key]
	end := min(off+n, int64(len(b)))
	return b[off:end], nil
}

func (o *fakeObjects) Delete(_ context.Context, key string) error { delete(o.data, key); return nil }

var pngBytes = append([]byte("\x89PNG\r\n\x1a\n"), bytes.Repeat([]byte{0}, 64)...)

func setupAtt() (*Service, *fakeStore, *fakeObjects) {
	f, r, o := newFake(), &recorder{}, &fakeObjects{data: map[string][]byte{}}
	return NewService(f, &seq{}, r, admins{9: true}, o), f, o
}

// upload pede a URL e "envia" o arquivo ao storage fake.
func upload(t *testing.T, s *Service, o *fakeObjects, user int64, ticketID string, body []byte) TicketUploadPayload {
	t.Helper()
	p, err := s.RequestUpload(context.Background(), user, ticketID, "captura.png", "image/png", int64(len(body)))
	if err != nil {
		t.Fatalf("pedido de upload: %v", err)
	}
	o.data[strings.TrimPrefix(p.UploadURL, "http://put/")] = body
	return p
}

// ---- testes ----

func TestUploadValidatesTypeSizeAndKey(t *testing.T) {
	s, f, _ := setupAtt()
	ctx := context.Background()
	for _, c := range []struct {
		name, ct string
		size     int64
	}{
		{"a.gif", "image/gif", 10}, {"a.pdf", "application/pdf", 10}, {"a.svg", "image/svg+xml", 10},
	} {
		if _, err := s.RequestUpload(ctx, 1, "", c.name, c.ct, c.size); !errors.Is(err, ErrImageOnly) {
			t.Fatalf("%s: %v", c.ct, err)
		}
	}
	if _, err := s.RequestUpload(ctx, 1, "", "a.png", "image/png", MaxAttachmentBytes+1); err == nil {
		t.Fatal("6 MB deveria ser recusado")
	}
	if _, err := s.RequestUpload(ctx, 1, "", "a.png", "image/png", 0); err == nil {
		t.Fatal("arquivo vazio deveria ser recusado")
	}
	if _, err := s.RequestUpload(ctx, 1, "", "a.jpg", "image/png", 10); err == nil {
		t.Fatal("extensão que não combina com o tipo deveria ser recusada")
	}
	p, err := s.RequestUpload(ctx, 1, "", "../minha captura.PNG", "image/png", 10)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := httpx.ParseID(p.ID)
	a := f.atts[id]
	if want := "tickets/" + p.TicketID + "/" + p.ID + ".png"; a.ObjectKey != want {
		t.Fatalf("chave = %q, esperado %q", a.ObjectKey, want)
	}
	if strings.Contains(a.Filename, "/") || p.Headers["Content-Type"] != "image/png" {
		t.Fatalf("nome %q, cabeçalhos %v", a.Filename, p.Headers)
	}
}

func TestUploadDisabledWithoutStorage(t *testing.T) {
	s, _, _ := setup()
	if _, err := s.RequestUpload(context.Background(), 1, "", "a.png", "image/png", 10); !errors.Is(err, ErrUploadsDisabled) {
		t.Fatalf("esperado ErrUploadsDisabled, veio %v", err)
	}
}

func TestUploadAuthorization(t *testing.T) {
	s, _, o := setupAtt()
	ctx := context.Background()
	d, err := s.Create(ctx, 1, KindBug, "Chamado", "corpo", nil, Attach{})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.RequestUpload(ctx, 2, d.ID, "a.png", "image/png", 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("outro usuário comum deveria receber 404: %v", err)
	}
	upload(t, s, o, 1, d.ID, pngBytes)
	upload(t, s, o, 9, d.ID, pngBytes) // admin
	if _, err := s.RequestUpload(ctx, 1, "999999", "a.png", "image/png", 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rascunho que não é dele: %v", err)
	}
	if _, err := s.RequestUpload(ctx, 1, "abc", "a.png", "image/png", 10); err == nil {
		t.Fatal("ID inválido deveria falhar")
	}
	// Rascunho: o segundo arquivo reaproveita o ID; outro usuário não consegue usá-lo.
	p1 := upload(t, s, o, 1, "", pngBytes)
	upload(t, s, o, 1, p1.TicketID, pngBytes)
	if _, err := s.RequestUpload(ctx, 2, p1.TicketID, "a.png", "image/png", 10); !errors.Is(err, ErrNotFound) {
		t.Fatalf("rascunho alheio: %v", err)
	}
}

func TestCreateWithAttachmentsAndVisibility(t *testing.T) {
	s, _, o := setupAtt()
	ctx := context.Background()
	p := upload(t, s, o, 1, "", pngBytes)
	d, err := s.Create(ctx, 1, KindBug, "Com imagem", "corpo", nil, Attach{DraftID: p.TicketID, IDs: []string{p.ID}})
	if err != nil {
		t.Fatal(err)
	}
	if d.ID != p.TicketID {
		t.Fatalf("o chamado deveria usar o ID do rascunho: %s != %s", d.ID, p.TicketID)
	}
	if len(d.Messages[0].Attachments) != 1 || !strings.Contains(d.Messages[0].Attachments[0].URL, "tickets/"+d.ID+"/") {
		t.Fatalf("anexos da abertura: %+v", d.Messages[0].Attachments)
	}
	if o.ttl != AttachmentReadTTL {
		t.Fatalf("TTL de leitura = %v", o.ttl)
	}
	// Reusar o mesmo anexo em outra mensagem é recusado.
	if _, err := s.Reply(ctx, 1, idOf(d.ID), "de novo", Attach{IDs: []string{p.ID}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("anexo reutilizado: %v", err)
	}
	// Nota interna com imagem: o autor não vê, o admin vê.
	np := upload(t, s, o, 9, d.ID, pngBytes)
	if _, err := s.AdminReply(ctx, 9, idOf(d.ID), "print da reprodução", true, Attach{IDs: []string{np.ID}}); err != nil {
		t.Fatal(err)
	}
	got, err := s.Get(ctx, 1, idOf(d.ID))
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range got.Messages {
		for _, a := range m.Attachments {
			if a.ID == np.ID {
				t.Fatal("imagem da nota interna vazou para o autor")
			}
		}
	}
	adm, err := s.AdminGet(ctx, idOf(d.ID))
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range adm.Messages {
		if m.Kind == "internal" && len(m.Attachments) == 1 && m.Attachments[0].ID == np.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("admin não viu a imagem da nota: %+v", adm.Messages)
	}
	// Resposta pública do admin com imagem chega ao autor.
	pp := upload(t, s, o, 9, d.ID, pngBytes)
	if _, err := s.AdminReply(ctx, 9, idOf(d.ID), "veja", false, Attach{IDs: []string{pp.ID}}); err != nil {
		t.Fatal(err)
	}
	got, _ = s.Get(ctx, 1, idOf(d.ID))
	if last := got.Messages[len(got.Messages)-1]; len(last.Attachments) != 1 {
		t.Fatalf("anexo da resposta pública: %+v", last)
	}
}

func idOf(s string) int64 {
	n, err := strconv.ParseInt(s, 10, 64)
	if err != nil {
		panic(err)
	}
	return n
}

func TestAttachmentRejections(t *testing.T) {
	s, f, o := setupAtt()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Chamado", "corpo", nil, Attach{})
	tid := idOf(d.ID)

	// Mais de 3 por mensagem.
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{"1", "2", "3", "4"}}); !errors.Is(err, ErrTooManyAttachments) {
		t.Fatalf("limite por mensagem: %v", err)
	}
	// Repetido e ID inválido.
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{"5", "5"}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("repetido: %v", err)
	}
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{"abc"}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("inválido: %v", err)
	}
	// Anexo de outro usuário.
	other := upload(t, s, o, 2, "", pngBytes)
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{other.ID}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("anexo alheio: %v", err)
	}
	// Anexo de outro chamado.
	d2, _ := s.Create(ctx, 1, KindBug, "Outro", "corpo", nil, Attach{})
	p2 := upload(t, s, o, 1, d2.ID, pngBytes)
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{p2.ID}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("anexo de outro chamado: %v", err)
	}
	// Não enviado ao storage.
	p3, _ := s.RequestUpload(ctx, 1, d.ID, "a.png", "image/png", 10)
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{p3.ID}}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("não enviado: %v", err)
	}
	// Conteúdo que não é PNG (magic bytes): recusa e apaga o objeto.
	fake := []byte("<html>não sou uma imagem</html>")
	p4, _ := s.RequestUpload(ctx, 1, d.ID, "a.png", "image/png", int64(len(fake)))
	key4 := strings.TrimPrefix(p4.UploadURL, "http://put/")
	o.data[key4] = fake
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{p4.ID}}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("magic bytes: %v", err)
	}
	if _, ok := o.data[key4]; ok || f.atts[idOf(p4.ID)] != nil {
		t.Fatal("o anexo recusado deveria ser apagado")
	}
	// Tamanho diferente do declarado.
	p5, _ := s.RequestUpload(ctx, 1, d.ID, "a.png", "image/png", 10)
	o.data[strings.TrimPrefix(p5.UploadURL, "http://put/")] = pngBytes
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{p5.ID}}); !apperr.IsKind(err, apperr.KindInvalid) {
		t.Fatalf("tamanho: %v", err)
	}
	// Expirado (fora da janela de 1 h).
	p6 := upload(t, s, o, 1, d.ID, pngBytes)
	f.atts[idOf(p6.ID)].CreatedAt = time.Now().Add(-2 * time.Hour)
	if _, err := s.Reply(ctx, 1, tid, "x", Attach{IDs: []string{p6.ID}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("expirado: %v", err)
	}
	// Rascunho no create sem ID, ou com o ID de um chamado que já existe.
	p7 := upload(t, s, o, 1, "", pngBytes)
	if _, err := s.Create(ctx, 1, KindBug, "Sem rascunho", "x", nil, Attach{IDs: []string{p7.ID}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("sem draft_id: %v", err)
	}
	if _, err := s.Create(ctx, 1, KindBug, "Rascunho existente", "x", nil, Attach{DraftID: d.ID, IDs: []string{p7.ID}}); !errors.Is(err, ErrInvalidAttachments) {
		t.Fatalf("draft_id de chamado existente: %v", err)
	}
}

func TestPendingAndPerTicketLimits(t *testing.T) {
	s, _, o := setupAtt()
	ctx := context.Background()
	d, _ := s.Create(ctx, 1, KindBug, "Chamado", "corpo", nil, Attach{})
	for i := 0; i < MaxPendingAttachments; i++ {
		upload(t, s, o, 1, d.ID, pngBytes)
	}
	if _, err := s.RequestUpload(ctx, 1, d.ID, "a.png", "image/png", 10); !errors.Is(err, ErrTooManyPendingFiles) {
		t.Fatalf("limite de pendentes: %v", err)
	}

	// Teto de 30 imagens por chamado: 10 respostas de 3 enchem; a próxima é recusada.
	s2, _, o2 := setupAtt()
	d2, _ := s2.Create(ctx, 1, KindBug, "Cheio", "corpo", nil, Attach{})
	for i := 0; i < 10; i++ {
		var ids []string
		for j := 0; j < MaxAttachmentsPerMsg; j++ {
			ids = append(ids, upload(t, s2, o2, 1, d2.ID, pngBytes).ID)
		}
		if _, err := s2.Reply(ctx, 1, idOf(d2.ID), fmt.Sprint("r", i), Attach{IDs: ids}); err != nil {
			t.Fatalf("resposta %d: %v", i, err)
		}
	}
	p := upload(t, s2, o2, 1, d2.ID, pngBytes)
	if _, err := s2.Reply(ctx, 1, idOf(d2.ID), "além", Attach{IDs: []string{p.ID}}); !errors.Is(err, ErrTicketAttachLimit) {
		t.Fatalf("teto por chamado: %v", err)
	}
}

func TestCleanupOrphans(t *testing.T) {
	s, f, o := setupAtt()
	ctx := context.Background()
	old := upload(t, s, o, 1, "", pngBytes)
	fresh := upload(t, s, o, 1, "", pngBytes)
	f.atts[idOf(old.ID)].CreatedAt = time.Now().Add(-2 * time.Hour)
	oldKey := f.atts[idOf(old.ID)].ObjectKey
	n, err := s.CleanupOrphans(ctx)
	if err != nil || n != 1 {
		t.Fatalf("removidos = %d, %v", n, err)
	}
	if _, ok := o.data[oldKey]; ok || f.atts[idOf(old.ID)] != nil {
		t.Fatal("o órfão antigo deveria sumir (linha e objeto)")
	}
	if f.atts[idOf(fresh.ID)] == nil {
		t.Fatal("o anexo recente não pode ser apagado")
	}
}
