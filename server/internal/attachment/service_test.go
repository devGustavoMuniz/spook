package attachment

import (
	"bytes"
	"context"
	"errors"
	"image/jpeg"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

type fakeStore struct {
	mu       sync.Mutex
	rows     map[int64]Attachment
	channels map[int64]int64 // id -> canal da mensagem
	pending  int
	byMsg    int
}

func newFakeStore() *fakeStore {
	return &fakeStore{rows: map[int64]Attachment{}, channels: map[int64]int64{}}
}

func (f *fakeStore) Insert(_ context.Context, a Attachment) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	a.CreatedAt = time.Now()
	f.rows[a.ID] = a
	return nil
}
func (f *fakeStore) CountPending(context.Context, int64, time.Time) (int, error) {
	return f.pending, nil
}
func (f *fakeStore) Pending(_ context.Context, ids []int64, uploader int64, prefix string, since time.Time) ([]Attachment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Attachment
	for _, id := range ids {
		a, ok := f.rows[id]
		if ok && a.UploaderID == uploader && a.MessageID == nil && strings.HasPrefix(a.ObjectKey, prefix) && a.CreatedAt.After(since) {
			out = append(out, a)
		}
	}
	return out, nil
}
func (f *fakeStore) ByMessages(_ context.Context, ids []int64) ([]Attachment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.byMsg++
	var out []Attachment
	for _, a := range f.rows {
		for _, id := range ids {
			if a.MessageID != nil && *a.MessageID == id {
				out = append(out, a)
			}
		}
	}
	return out, nil
}
func (f *fakeStore) ForThumbnail(_ context.Context, id int64) (Attachment, int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	a, ok := f.rows[id]
	if !ok {
		return Attachment{}, 0, ErrNotFound
	}
	return a, f.channels[id], nil
}
func (f *fakeStore) SetThumbnail(_ context.Context, id int64, w, h int, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	a := f.rows[id]
	w32, h32 := int32(w), int32(h)
	a.Width, a.Height, a.ThumbnailKey = &w32, &h32, &key
	f.rows[id] = a
	return nil
}
func (f *fakeStore) Orphans(_ context.Context, before time.Time, limit int) ([]Attachment, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []Attachment
	for _, a := range f.rows {
		if a.MessageID == nil && a.CreatedAt.Before(before) && len(out) < limit {
			out = append(out, a)
		}
	}
	return out, nil
}
func (f *fakeStore) DeletePending(_ context.Context, ids []int64) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, id := range ids {
		delete(f.rows, id)
	}
	return nil
}

type fakeObjects struct {
	mu      sync.Mutex
	objs    map[string][]byte
	puts    map[string]string // chave -> content type
	deleted []string
	getErr  error
	putErr  error
}

func newFakeObjects() *fakeObjects {
	return &fakeObjects{objs: map[string][]byte{}, puts: map[string]string{}}
}

func (f *fakeObjects) PresignPut(_ context.Context, key, ct string, size int64, ttl time.Duration) (string, error) {
	return "http://s3/put/" + key + "?ct=" + ct + "&ttl=" + ttl.String(), nil
}
func (f *fakeObjects) PresignGet(_ context.Context, key string, _ time.Duration) (string, error) {
	return "http://s3/get/" + key, nil
}
func (f *fakeObjects) Stat(_ context.Context, key string) (storage.ObjectInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.objs[key]
	if !ok {
		return storage.ObjectInfo{}, storage.ErrNotFound
	}
	return storage.ObjectInfo{Size: int64(len(b))}, nil
}
func (f *fakeObjects) GetRange(_ context.Context, key string, off, n int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	b, ok := f.objs[key]
	if !ok {
		return nil, storage.ErrNotFound
	}
	return b[off:min(int64(len(b)), off+n)], nil
}
func (f *fakeObjects) Get(_ context.Context, key string, max int64) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.getErr != nil {
		return nil, f.getErr
	}
	b, ok := f.objs[key]
	if !ok {
		return nil, storage.ErrNotFound
	}
	if int64(len(b)) > max {
		return nil, storage.ErrTooLarge
	}
	return b, nil
}
func (f *fakeObjects) Put(_ context.Context, key, ct string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.putErr != nil {
		return f.putErr
	}
	f.objs[key], f.puts[key] = data, ct
	return nil
}
func (f *fakeObjects) Delete(_ context.Context, key string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.objs, key)
	f.deleted = append(f.deleted, key)
	return nil
}

type fakeChannels struct {
	err  error
	need perm.Perm
}

func (f *fakeChannels) Authorize(_ context.Context, _, _ int64, need perm.Perm) (channel.Channel, perm.Member, error) {
	f.need = need
	return channel.Channel{Type: channel.TypeText}, perm.Member{}, f.err
}

type fakeLimiter struct{ ok bool }

func (f fakeLimiter) Take(string) (bool, time.Duration) { return f.ok, time.Second }

type seq struct{ n int64 }

func (s *seq) Next() int64 { s.n++; return 500 + s.n }

func setup() (*Service, *fakeStore, *fakeObjects, *fakeChannels) {
	st, ob, ch := newFakeStore(), newFakeObjects(), &fakeChannels{}
	return NewService(st, ob, ch, fakeLimiter{ok: true}, &seq{}), st, ob, ch
}

func TestRequestUploadHappyPath(t *testing.T) {
	svc, st, _, ch := setup()
	up, err := svc.RequestUpload(context.Background(), 1, 20, "Relatório Final.pdf", "application/pdf", 1234)
	if err != nil {
		t.Fatal(err)
	}
	if ch.need != perm.SendMessages|perm.AttachFiles {
		t.Fatalf("precisa de SEND_MESSAGES e ATTACH_FILES, pediu %b", ch.need)
	}
	if up.ID != "501" || up.ExpiresIn != 300 || up.Headers["Content-Type"] != "application/pdf" || up.UploadURL == "" {
		t.Fatalf("resposta: %+v", up)
	}
	row := st.rows[501]
	if row.ObjectKey != "attachments/20/501/Relat_rio_Final.pdf" || row.Filename != "Relatório Final.pdf" || row.UploaderID != 1 || row.Size != 1234 || row.MessageID != nil {
		t.Fatalf("linha: %+v", row)
	}
	if !strings.Contains(up.UploadURL, row.ObjectKey) || !strings.Contains(up.UploadURL, "ttl=5m0s") {
		t.Fatalf("URL: %s", up.UploadURL)
	}
}

func TestRequestUploadRejections(t *testing.T) {
	ctx := context.Background()
	t.Run("sem permissão", func(t *testing.T) {
		svc, st, _, ch := setup()
		ch.err = channel.ErrForbidden
		if _, err := svc.RequestUpload(ctx, 1, 20, "a.png", "image/png", 5); !errors.Is(err, channel.ErrForbidden) || len(st.rows) != 0 {
			t.Fatalf("%v", err)
		}
	})
	t.Run("não participante", func(t *testing.T) {
		svc, _, _, ch := setup()
		ch.err = channel.ErrNotFound
		if _, err := svc.RequestUpload(ctx, 1, 20, "a.png", "image/png", 5); !errors.Is(err, channel.ErrNotFound) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("tamanho e tipo", func(t *testing.T) {
		svc, st, _, _ := setup()
		for _, c := range []struct {
			ct   string
			size int64
		}{{"image/png", MaxFileSize + 1}, {"image/png", 0}, {"image/svg+xml", 5}, {"application/octet-stream", 5}} {
			if _, err := svc.RequestUpload(ctx, 1, 20, "a.png", c.ct, c.size); !apperr.IsKind(err, apperr.KindInvalid) {
				t.Fatalf("%v: %v", c, err)
			}
		}
		if len(st.rows) != 0 {
			t.Fatal("pedido recusado não deve criar linha")
		}
	})
	t.Run("rate limit", func(t *testing.T) {
		svc, st, _, _ := setup()
		svc.limiter = fakeLimiter{ok: false}
		if _, err := svc.RequestUpload(ctx, 1, 20, "a.png", "image/png", 5); !apperr.IsKind(err, apperr.KindRateLimited) || len(st.rows) != 0 {
			t.Fatalf("%v", err)
		}
	})
	t.Run("pendentes demais", func(t *testing.T) {
		svc, st, _, _ := setup()
		st.pending = MaxPending
		if _, err := svc.RequestUpload(ctx, 1, 20, "a.png", "image/png", 5); !apperr.IsKind(err, apperr.KindConflict) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("storage desligado", func(t *testing.T) {
		svc, _, _, _ := setup()
		svc.objects = nil
		if _, err := svc.RequestUpload(ctx, 1, 20, "a.png", "image/png", 5); !apperr.IsKind(err, apperr.KindUnavailable) {
			t.Fatalf("%v", err)
		}
	})
}

// seed cria um anexo pendente com o objeto no storage.
func seed(t *testing.T, svc *Service, st *fakeStore, ob *fakeObjects, filename, ct string, body []byte) int64 {
	t.Helper()
	up, err := svc.RequestUpload(context.Background(), 1, 20, filename, ct, int64(len(body)))
	if err != nil {
		t.Fatal(err)
	}
	var id int64
	for k := range st.rows {
		if httpxID(k) == up.ID {
			id = k
		}
	}
	ob.objs[st.rows[id].ObjectKey] = body
	return id
}

func httpxID(id int64) string { return strconv.FormatInt(id, 10) }
func itoa(i int64) string     { return strconv.FormatInt(i, 10) }

var pngMagic = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")

func TestVerify(t *testing.T) {
	ctx := context.Background()
	t.Run("ok", func(t *testing.T) {
		svc, st, ob, _ := setup()
		id := seed(t, svc, st, ob, "a.png", "image/png", pngMagic)
		if err := svc.Verify(ctx, 1, 20, []int64{id}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("arquivo ainda não enviado", func(t *testing.T) {
		svc, st, ob, _ := setup()
		id := seed(t, svc, st, ob, "a.png", "image/png", pngMagic)
		delete(ob.objs, st.rows[id].ObjectKey)
		if err := svc.Verify(ctx, 1, 20, []int64{id}); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Fatalf("%v", err)
		}
		if _, ok := st.rows[id]; !ok {
			t.Fatal("a linha deve continuar: o cliente ainda pode enviar")
		}
	})
	t.Run("tamanho diferente apaga objeto e linha", func(t *testing.T) {
		svc, st, ob, _ := setup()
		id := seed(t, svc, st, ob, "a.png", "image/png", pngMagic)
		key := st.rows[id].ObjectKey
		ob.objs[key] = append(pngMagic, 1, 2, 3)
		if err := svc.Verify(ctx, 1, 20, []int64{id}); !apperr.IsKind(err, apperr.KindInvalid) {
			t.Fatalf("%v", err)
		}
		if _, ok := ob.objs[key]; ok || len(st.rows) != 0 {
			t.Fatal("objeto e linha deveriam ter sido apagados")
		}
	})
	t.Run("magic bytes divergentes apagam", func(t *testing.T) {
		svc, st, ob, _ := setup()
		html := []byte("<html><script>alert(1)</script></html>")
		id := seed(t, svc, st, ob, "a.png", "image/png", html)
		key := st.rows[id].ObjectKey
		err := svc.Verify(ctx, 1, 20, []int64{id})
		if !apperr.IsKind(err, apperr.KindInvalid) || !strings.Contains(err.Error(), "não corresponde") {
			t.Fatalf("%v", err)
		}
		if _, ok := ob.objs[key]; ok || len(st.rows) != 0 {
			t.Fatal("objeto e linha deveriam ter sido apagados")
		}
	})
	t.Run("texto não confere magic bytes", func(t *testing.T) {
		svc, st, ob, _ := setup()
		id := seed(t, svc, st, ob, "a.txt", "text/plain", []byte("\x00\x01qualquer coisa"))
		if err := svc.Verify(ctx, 1, 20, []int64{id}); err != nil {
			t.Fatal(err)
		}
	})
	t.Run("de outro usuário, de outro canal, já usado ou expirado", func(t *testing.T) {
		svc, st, ob, _ := setup()
		id := seed(t, svc, st, ob, "a.png", "image/png", pngMagic)
		if err := svc.Verify(ctx, 2, 20, []int64{id}); !errors.Is(err, ErrInvalidAttachments) {
			t.Fatalf("outro usuário: %v", err)
		}
		if err := svc.Verify(ctx, 1, 21, []int64{id}); !errors.Is(err, ErrInvalidAttachments) {
			t.Fatalf("outro canal: %v", err)
		}
		if err := svc.Verify(ctx, 1, 20, []int64{id, 99999}); !errors.Is(err, ErrInvalidAttachments) {
			t.Fatalf("inexistente: %v", err)
		}
		svc.now = func() time.Time { return time.Now().Add(2 * time.Hour) }
		if err := svc.Verify(ctx, 1, 20, []int64{id}); !errors.Is(err, ErrInvalidAttachments) {
			t.Fatalf("expirado: %v", err)
		}
		svc.now = time.Now
		m := int64(7)
		a := st.rows[id]
		a.MessageID = &m
		st.rows[id] = a
		if err := svc.Verify(ctx, 1, 20, []int64{id}); !errors.Is(err, ErrInvalidAttachments) {
			t.Fatalf("já usado: %v", err)
		}
	})
}

func TestForMessagesIsBatchedAndBuildsURLs(t *testing.T) {
	svc, st, _, _ := setup()
	m1, m2 := int64(1), int64(2)
	thumb := "thumbnails/11.jpg"
	st.rows[10] = Attachment{ID: 10, MessageID: &m1, ObjectKey: "attachments/20/10/a.png", Filename: "a.png", ContentType: "image/png", Size: 5}
	st.rows[11] = Attachment{ID: 11, MessageID: &m1, ObjectKey: "attachments/20/11/b.png", Filename: "b.png", ContentType: "image/png", Size: 6, ThumbnailKey: &thumb}
	st.rows[12] = Attachment{ID: 12, MessageID: &m2, ObjectKey: "attachments/20/12/c.pdf", Filename: "c.pdf", ContentType: "application/pdf", Size: 7}
	got, err := svc.ForMessages(context.Background(), []int64{1, 2, 3})
	if err != nil {
		t.Fatal(err)
	}
	if st.byMsg != 1 {
		t.Fatalf("esperava 1 consulta, houve %d", st.byMsg)
	}
	if len(got[1]) != 2 || len(got[2]) != 1 || len(got[3]) != 0 {
		t.Fatalf("agrupamento: %+v", got)
	}
	var withThumb int
	for _, p := range got[1] {
		if p.URL == "" {
			t.Fatal("sem URL")
		}
		if p.ThumbnailURL != "" {
			withThumb++
		}
	}
	if withThumb != 1 {
		t.Fatalf("só um tem thumbnail: %+v", got[1])
	}
	svc.objects = nil
	if m, err := svc.ForMessages(context.Background(), []int64{1}); err != nil || m != nil {
		t.Fatalf("storage desligado: %v %v", m, err)
	}
}

func TestCleanupOrphans(t *testing.T) {
	svc, st, ob, _ := setup()
	old, fresh, used := seed(t, svc, st, ob, "a.png", "image/png", pngMagic), seed(t, svc, st, ob, "b.png", "image/png", pngMagic), seed(t, svc, st, ob, "c.png", "image/png", pngMagic)
	for _, id := range []int64{old, used} {
		a := st.rows[id]
		a.CreatedAt = time.Now().Add(-2 * time.Hour)
		st.rows[id] = a
	}
	m := int64(9)
	a := st.rows[used]
	a.MessageID = &m
	st.rows[used] = a
	oldKey := st.rows[old].ObjectKey

	n, err := svc.CleanupOrphans(context.Background())
	if err != nil || n != 1 {
		t.Fatalf("n=%d err=%v", n, err)
	}
	if _, ok := st.rows[old]; ok {
		t.Fatal("órfão velho deveria sumir")
	}
	if _, ok := ob.objs[oldKey]; ok {
		t.Fatal("objeto do órfão deveria sumir")
	}
	if _, ok := st.rows[fresh]; !ok {
		t.Fatal("anexo recente deve ficar")
	}
	if _, ok := st.rows[used]; !ok {
		t.Fatal("anexo de mensagem deve ficar")
	}
}

// ---- worker de thumbnail ----

type fakePub struct {
	calls [][2]int64
	err   error
}

func (f *fakePub) RepublishUpdate(_ context.Context, ch, msg int64) error {
	f.calls = append(f.calls, [2]int64{ch, msg})
	return f.err
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, gradient(w, h, 255), nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func workerSetup(t *testing.T, body []byte, ct string) (*ThumbnailWorker, *fakeStore, *fakeObjects, *fakePub, int64) {
	t.Helper()
	svc, st, ob, _ := setup()
	name := "a.jpg"
	if ct == "image/png" {
		name = "a.png"
	}
	id := seed(t, svc, st, ob, name, ct, body)
	m := int64(77)
	a := st.rows[id]
	a.MessageID = &m
	st.rows[id] = a
	st.channels[id] = 20
	pub := &fakePub{}
	return &ThumbnailWorker{svc: svc, pub: pub}, st, ob, pub, id
}

func TestThumbnailWorkerGeneratesAndRepublishes(t *testing.T) {
	w, st, ob, pub, id := workerSetup(t, jpegBytes(t, 1000, 500), "image/jpeg")
	if err := w.process(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	row := st.rows[id]
	if row.ThumbnailKey == nil || *row.ThumbnailKey != "thumbnails/"+itoa(id)+".jpg" || *row.Width != 1000 || *row.Height != 500 {
		t.Fatalf("linha: %+v", row)
	}
	if ob.puts[*row.ThumbnailKey] != "image/jpeg" {
		t.Fatalf("puts: %v", ob.puts)
	}
	if len(pub.calls) != 1 || pub.calls[0] != [2]int64{20, 77} {
		t.Fatalf("republicação: %v", pub.calls)
	}
}

func TestThumbnailWorkerIsIdempotent(t *testing.T) {
	w, st, ob, pub, id := workerSetup(t, jpegBytes(t, 800, 800), "image/jpeg")
	if err := w.process(context.Background(), id); err != nil {
		t.Fatal(err)
	}
	ob.getErr = errors.New("não deveria baixar de novo")
	if err := w.process(context.Background(), id); err != nil {
		t.Fatalf("segunda execução: %v", err)
	}
	if len(pub.calls) != 2 || len(st.rows) != 1 {
		t.Fatalf("a retentativa republica sem refazer: %v", pub.calls)
	}
}

func TestThumbnailWorkerDiscardsUnrecoverable(t *testing.T) {
	ctx := context.Background()
	for name, body := range map[string][]byte{
		"corrompida": []byte("não sou uma imagem"),
		"gigante":    pngHeaderOnly(10000, 10000),
	} {
		t.Run(name, func(t *testing.T) {
			w, st, ob, pub, id := workerSetup(t, body, "image/png")
			err := w.process(ctx, id)
			if !errors.Is(err, errDiscard) {
				t.Fatalf("esperava descarte, veio %v", err)
			}
			if st.rows[id].ThumbnailKey != nil || len(ob.puts) != 0 || len(pub.calls) != 0 {
				t.Fatal("sem thumbnail, sem gravação e sem evento")
			}
		})
	}
	t.Run("anexo sumiu", func(t *testing.T) {
		w, _, _, _, _ := workerSetup(t, jpegBytes(t, 10, 10), "image/jpeg")
		if err := w.process(ctx, 999999); !errors.Is(err, errDiscard) {
			t.Fatalf("%v", err)
		}
	})
	t.Run("objeto sumiu", func(t *testing.T) {
		w, st, ob, _, id := workerSetup(t, jpegBytes(t, 10, 10), "image/jpeg")
		delete(ob.objs, st.rows[id].ObjectKey)
		if err := w.process(ctx, id); !errors.Is(err, errDiscard) {
			t.Fatalf("%v", err)
		}
	})
}

func TestThumbnailWorkerRetriesTransientFailures(t *testing.T) {
	ctx := context.Background()
	w, _, ob, _, id := workerSetup(t, jpegBytes(t, 100, 100), "image/jpeg")
	ob.getErr = errors.New("storage fora do ar")
	if err := w.process(ctx, id); err == nil || errors.Is(err, errDiscard) {
		t.Fatalf("falha de download deve ser retentável: %v", err)
	}
	ob.getErr = nil
	ob.putErr = errors.New("storage fora do ar")
	if err := w.process(ctx, id); err == nil || errors.Is(err, errDiscard) {
		t.Fatalf("falha de gravação deve ser retentável: %v", err)
	}
	ob.putErr = nil
	if err := w.process(ctx, id); err != nil {
		t.Fatalf("depois de voltar: %v", err)
	}
}

func TestThumbnailJobMaxAttempts(t *testing.T) {
	if o := (ThumbnailArgs{}).InsertOpts(); o.MaxAttempts != 3 || o.Queue != "thumbnail" {
		t.Fatalf("opções: %+v", o)
	}
}
