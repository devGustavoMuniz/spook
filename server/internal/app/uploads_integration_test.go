//go:build integration

package app

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"

	"github.com/devGustavoMuniz/spook/server/internal/attachment"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

// ---------- helpers de upload ----------

func testStorage(t *testing.T) *storage.Store {
	t.Helper()
	st, err := storage.New(t.Context(), storage.Config{
		Endpoint: env(t, "S3_ENDPOINT"), Region: env(t, "S3_REGION"), Bucket: env(t, "S3_BUCKET"),
		AccessKeyID: env(t, "S3_ACCESS_KEY_ID"), SecretAccessKey: env(t, "S3_SECRET_ACCESS_KEY"),
	})
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func pngBytes(t *testing.T, w, h int, alpha uint8) []byte {
	t.Helper()
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x), G: uint8(y), B: 90, A: alpha})
		}
	}
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func jpegBytes(t *testing.T, w, h int) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 200, A: 255})
		}
	}
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func (a *actor) requestUpload(t *testing.T, channelID, filename, ct string, size int, want int) J {
	t.Helper()
	return obj(t, a.call(t, "POST", "/api/channels/"+channelID+"/uploads", J{"filename": filename, "content_type": ct, "size": size}, want))
}

// put envia o arquivo direto ao storage, como o navegador: URL e cabeçalhos devolvidos pela API.
func put(t *testing.T, up J, body []byte) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, str(up, "upload_url"), bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	hs, _ := up["headers"].(map[string]any)
	for k, v := range hs {
		req.Header.Set(k, v.(string))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return resp
}

// upload pede a URL, envia o arquivo ao storage e devolve o id do anexo.
func (a *actor) upload(t *testing.T, channelID, filename, ct string, body []byte) string {
	t.Helper()
	up := a.requestUpload(t, channelID, filename, ct, len(body), 201)
	if resp := put(t, up, body); resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT no storage = %d: %s", resp.StatusCode, b)
	}
	return str(up, "id")
}

func (a *actor) sendWith(t *testing.T, channelID, content string, ids []string, want int) J {
	t.Helper()
	body := J{"content": content}
	if ids != nil {
		body["attachment_ids"] = ids
	}
	return obj(t, a.call(t, "POST", "/api/channels/"+channelID+"/messages", body, want))
}

func download(t *testing.T, url string) ([]byte, string) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("GET %s = %d: %s", url, resp.StatusCode, b)
	}
	return b, resp.Header.Get("Content-Type")
}

func atts(m J) []J { return list(m, "attachments") }

func uploadsEnv(t *testing.T) *testEnv {
	return newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.UploadLimiter = ratelimit.New(100000, 100000)
	})
}

// ---------- fluxo completo + thumbnail ----------

func TestUploadFlowWithThumbnailOverWebSocket(t *testing.T) {
	e := uploadsEnv(t)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Anexos", owner, member)
	ws, _ := member.connectReady(t)

	photo := jpegBytes(t, 1200, 600)
	doc := []byte("%PDF-1.7\nconteúdo do pdf de teste\n")
	imgID := owner.upload(t, g.textID, "foto de férias.jpg", "image/jpeg", photo)
	pdfID := owner.upload(t, g.textID, "relatório.pdf", "application/pdf", doc)

	msg := owner.sendWith(t, g.textID, "olha só", []string{imgID, pdfID}, 201)
	as := atts(msg)
	if len(as) != 2 || str(as[0], "id") != imgID || str(as[1], "id") != pdfID {
		t.Fatalf("anexos da resposta: %v", msg["attachments"])
	}
	if str(as[0], "filename") != "foto de férias.jpg" || str(as[0], "content_type") != "image/jpeg" || num(as[0], "size") != int64(len(photo)) {
		t.Fatalf("anexo: %v", as[0])
	}
	if as[0]["thumbnail_url"] != nil || as[0]["width"] != nil {
		t.Fatalf("o thumbnail ainda não existe na resposta do envio: %v", as[0])
	}
	if got, _ := download(t, str(as[0], "url")); !bytes.Equal(got, photo) {
		t.Fatal("o original baixado difere do enviado")
	}
	if got, ct := download(t, str(as[1], "url")); !bytes.Equal(got, doc) || ct != "application/pdf" {
		t.Fatalf("pdf: ct=%s", ct)
	}

	// MESSAGE_CREATE com anexos, depois MESSAGE_UPDATE com thumbnail_url (job do River)
	created := payload(t, ws.event("MESSAGE_CREATE"))
	if len(atts(created)) != 2 || atts(created)[0]["thumbnail_url"] != nil {
		t.Fatalf("MESSAGE_CREATE: %v", created)
	}
	updated := payload(t, ws.event("MESSAGE_UPDATE"))
	if str(updated, "id") != str(msg, "id") || str(updated, "content") != "olha só" {
		t.Fatalf("MESSAGE_UPDATE: %v", updated)
	}
	ua := atts(updated)
	if len(ua) != 2 || str(ua[0], "thumbnail_url") == "" || num(ua[0], "width") != 1200 || num(ua[0], "height") != 600 {
		t.Fatalf("anexo atualizado: %v", ua)
	}
	if ua[1]["thumbnail_url"] != nil {
		t.Fatalf("pdf não tem thumbnail: %v", ua[1])
	}
	thumb, ct := download(t, str(ua[0], "thumbnail_url"))
	cfg, _, err := image.DecodeConfig(bytes.NewReader(thumb))
	if err != nil || cfg.Width != 400 || cfg.Height != 200 || ct != "image/jpeg" {
		t.Fatalf("thumbnail: %dx%d ct=%s err=%v", cfg.Width, cfg.Height, ct, err)
	}

	// histórico traz o mesmo
	hist := obj(t, member.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200))
	ha := atts(list(hist, "messages")[0])
	if len(ha) != 2 || str(ha[0], "thumbnail_url") == "" || num(ha[0], "width") != 1200 {
		t.Fatalf("histórico: %v", ha)
	}

	// mensagem apagada some com os anexos
	owner.call(t, "DELETE", "/api/channels/"+g.textID+"/messages/"+str(msg, "id"), nil, 204)
	hist = obj(t, member.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 200))
	if len(list(hist, "messages")) != 0 {
		t.Fatalf("mensagem apagada continua no histórico: %v", hist)
	}
}

func TestTransparentPNGThumbnailStaysPNG(t *testing.T) {
	e := uploadsEnv(t)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Alfa")
	ws, _ := owner.connectReady(t)
	id := owner.upload(t, g.textID, "logo.png", "image/png", pngBytes(t, 300, 900, 120))
	owner.sendWith(t, g.textID, "", []string{id}, 201) // só anexo, sem texto
	ws.event("MESSAGE_CREATE")
	up := atts(payload(t, ws.event("MESSAGE_UPDATE")))[0]
	b, ct := download(t, str(up, "thumbnail_url"))
	cfg, _, err := image.DecodeConfig(bytes.NewReader(b))
	if err != nil || ct != "image/png" || cfg.Width != 133 || cfg.Height != 400 {
		t.Fatalf("thumbnail: %+v ct=%s err=%v", cfg, ct, err)
	}
}

func waitJobState(t *testing.T, e *testEnv, attachmentID string, states ...string) string {
	t.Helper()
	var state string
	waitUntil2(t, "job do anexo "+attachmentID+" em "+strings.Join(states, "/"), 15*time.Second, func() bool {
		err := e.pool.QueryRow(t.Context(),
			`SELECT state::text FROM river_job WHERE kind = 'thumbnail' AND (args->>'attachment_id') = $1 ORDER BY id DESC LIMIT 1`, attachmentID).Scan(&state)
		if err != nil {
			return false
		}
		for _, s := range states {
			if state == s {
				return true
			}
		}
		return false
	})
	return state
}

func waitUntil2(t *testing.T, what string, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("não atingiu a tempo: %s", what)
}

func TestUnprocessableImagesAreDiscardedWithoutRetry(t *testing.T) {
	e := uploadsEnv(t)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Corrompidas")
	ws, _ := owner.connectReady(t)

	// assinatura de PNG válida (passa na conferência dos primeiros bytes), mas o corpo é lixo
	corrupt := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"), bytes.Repeat([]byte{7}, 200)...)
	// cabeçalho de 20000x20000 (400 MP): recusado pelas dimensões, sem decodificar
	huge := append([]byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x4e\x20\x00\x00\x4e\x20\x08\x02\x00\x00\x00"), bytes.Repeat([]byte{0}, 64)...)

	for name, body := range map[string][]byte{"corrompida": corrupt, "gigante": huge} {
		id := owner.upload(t, g.textID, name+".png", "image/png", body)
		msg := owner.sendWith(t, g.textID, name, []string{id}, 201)
		if waitJobState(t, e, id, "cancelled", "discarded", "completed") != "cancelled" {
			t.Fatalf("%s: o job deveria ser cancelado sem retentar", name)
		}
		var attempts int
		if err := e.pool.QueryRow(t.Context(), `SELECT attempt FROM river_job WHERE kind = 'thumbnail' AND (args->>'attachment_id') = $1`, id).Scan(&attempts); err != nil || attempts != 1 {
			t.Fatalf("%s: tentativas = %d (%v), esperado 1", name, attempts, err)
		}
		// a mensagem segue com o original, sem thumbnail
		hist := obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages?limit=1", nil, 200))
		a := atts(list(hist, "messages")[0])[0]
		if str(list(hist, "messages")[0], "id") != str(msg, "id") || a["thumbnail_url"] != nil || str(a, "url") == "" {
			t.Fatalf("%s: histórico %v", name, a)
		}
	}
	ws.event("MESSAGE_CREATE")
	ws.noEvent2(1500 * time.Millisecond)
}

// noEvent2 falha se chegar MESSAGE_UPDATE durante d (o thumbnail descartado não publica nada).
func (c *wsClient) noEvent2(d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			return
		}
		if isEvent(f, "MESSAGE_UPDATE") {
			c.t.Fatalf("não deveria haver MESSAGE_UPDATE: %s", f.D)
		}
	}
}

// ---------- rejeições do pedido de upload ----------

func TestRequestUploadRejections(t *testing.T) {
	e := uploadsEnv(t)
	owner, member, stranger := e.newActor(t, "dono"), e.newActor(t, "membro"), e.newActor(t, "fora")
	g := friends(t, "Rejeicoes", owner, member)
	url := "/api/channels/" + g.textID + "/uploads"

	// acima de 25 MB: 422 com mensagem clara
	b := owner.call(t, "POST", url, J{"filename": "grande.zip", "content_type": "application/zip", "size": 25<<20 + 1}, 422)
	if !strings.Contains(string(b), "25 MB") {
		t.Fatalf("mensagem deveria citar 25 MB: %s", b)
	}
	owner.requestUpload(t, g.textID, "limite.zip", "application/zip", 25<<20, 201) // exatamente 25 MB vale
	owner.requestUpload(t, g.textID, "vazio.zip", "application/zip", 0, 422)

	// tipos fora da lista de permissão
	for _, c := range [][2]string{
		{"x.svg", "image/svg+xml"}, {"x.html", "text/html"}, {"x.exe", "application/x-msdownload"},
		{"x.bin", "application/octet-stream"}, {"x.js", "text/javascript"}, {"x.png", ""},
	} {
		owner.requestUpload(t, g.textID, c[0], c[1], 10, 422)
	}
	owner.requestUpload(t, g.textID, "x.exe", "image/png", 10, 422) // extensão incoerente
	owner.requestUpload(t, g.textID, "semextensao", "image/png", 10, 422)
	owner.requestUpload(t, g.textID, "../../etc/passwd", "text/plain", 10, 422)

	// nome sanitizado
	up := owner.requestUpload(t, g.textID, "../..\\segredo\x00.txt", "text/plain", 10, 201)
	var key string
	if err := e.pool.QueryRow(t.Context(), `SELECT object_key FROM attachments WHERE id = $1::bigint`, str(up, "id")).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if key != "attachments/"+g.textID+"/"+str(up, "id")+"/segredo.txt" {
		t.Fatalf("chave do objeto: %s", key)
	}
	if hs := up["headers"].(map[string]any); hs["Content-Type"] != "text/plain" || num(up, "expires_in") != 300 {
		t.Fatalf("resposta: %v", up)
	}

	// canal de voz, canal inexistente e id malformado
	owner.call(t, "POST", "/api/channels/"+g.voiceID+"/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 5}, 422)
	owner.call(t, "POST", "/api/channels/999/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 5}, 404)
	owner.call(t, "POST", "/api/channels/abc/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 5}, 404)

	// não membro: 404. Sem sessão: 401.
	stranger.call(t, "POST", url, J{"filename": "a.png", "content_type": "image/png", "size": 5}, 404)
	resp, bb := e.do(t, "POST", url, J{"filename": "a.png", "content_type": "image/png", "size": 5}, nil)
	status(t, resp, bb, 401)

	// sem ATTACH_FILES: 403 (continua podendo mandar texto)
	owner.call(t, "PATCH", "/api/guilds/"+g.id+"/roles/"+g.id, J{"permissions": int64(perm.ViewChannel | perm.SendMessages)}, 200)
	member.call(t, "POST", url, J{"filename": "a.png", "content_type": "image/png", "size": 5}, 403)
	member.say(t, g.textID, "só texto", 201)
	owner.requestUpload(t, g.textID, "dono.png", "image/png", 5, 201) // o dono tem tudo
}

func TestUploadRateLimitAndPendingLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.UploadLimiter = ratelimit.New(0.0001, 3) // 3 de rajada
	})
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Limites")
	for i := 0; i < 3; i++ {
		owner.requestUpload(t, g.textID, "a.png", "image/png", 5, 201)
	}
	resp, b := owner.do(t, "POST", "/api/channels/"+g.textID+"/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 5})
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}

	// pendentes: no máximo MaxPending por usuário
	e2 := uploadsEnv(t)
	u := e2.newActor(t, "pend")
	g2 := u.createGuild(t, "Pendentes")
	for i := 0; i < attachment.MaxPending; i++ {
		u.requestUpload(t, g2.textID, "a.png", "image/png", 5, 201)
	}
	u.call(t, "POST", "/api/channels/"+g2.textID+"/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 5}, 409)
}

// ---------- rejeições no envio da mensagem ----------

func TestSendMessageAttachmentRules(t *testing.T) {
	e := uploadsEnv(t)
	owner, member := e.newActor(t, "dono"), e.newActor(t, "membro")
	g := friends(t, "Regras", owner, member)
	other := owner.createGuild(t, "Outro servidor")
	st := testStorage(t)
	txt := func(a *actor, ch string) string { return a.upload(t, ch, "n.txt", "text/plain", []byte("nota")) }

	// sem conteúdo e sem anexo
	owner.sendWith(t, g.textID, "", nil, 422)
	owner.sendWith(t, g.textID, "   ", []string{}, 422)

	// 11 anexos: 422; 10: ok (e conteúdo vazio com anexo)
	var ids []string
	for i := 0; i < 11; i++ {
		ids = append(ids, txt(owner, g.textID))
	}
	b := owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "x", "attachment_ids": ids}, 422)
	if !strings.Contains(string(b), "10 anexos") {
		t.Fatalf("mensagem: %s", b)
	}
	ok := owner.sendWith(t, g.textID, "", ids[:10], 201)
	if len(atts(ok)) != 10 || str(ok, "content") != "" {
		t.Fatalf("10 anexos: %v", ok)
	}

	// anexo já usado, repetido, inexistente, malformado
	owner.sendWith(t, g.textID, "reuso", []string{ids[0]}, 422)
	fresh := txt(owner, g.textID)
	owner.sendWith(t, g.textID, "dup", []string{fresh, fresh}, 422)
	owner.sendWith(t, g.textID, "inexistente", []string{"123456789"}, 422)
	owner.sendWith(t, g.textID, "lixo", []string{"abc"}, 422)

	// anexo de outro usuário
	mine := txt(owner, g.textID)
	member.sendWith(t, g.textID, "roubado", []string{mine}, 422)
	// anexo de outro canal (outro servidor)
	owner.sendWith(t, other.textID, "canal errado", []string{mine}, 422)
	// o dono ainda consegue usar o anexo no canal certo (as recusas não o consumiram)
	owner.sendWith(t, g.textID, "agora sim", []string{mine}, 201)

	// objeto não enviado ao storage
	up := owner.requestUpload(t, g.textID, "n.txt", "text/plain", 5, 201)
	owner.sendWith(t, g.textID, "sem PUT", []string{str(up, "id")}, 422)
	put(t, up, []byte("12345"))
	owner.sendWith(t, g.textID, "com PUT", []string{str(up, "id")}, 201)

	// expirado (mais de 1 h)
	old := txt(owner, g.textID)
	if _, err := e.pool.Exec(t.Context(), `UPDATE attachments SET created_at = now() - interval '61 minutes' WHERE id = $1::bigint`, old); err != nil {
		t.Fatal(err)
	}
	owner.sendWith(t, g.textID, "expirado", []string{old}, 422)

	// tamanho no storage diferente do declarado: 422 e o objeto é apagado
	sz := owner.requestUpload(t, g.textID, "n.txt", "text/plain", 10, 201)
	var szKey string
	_ = e.pool.QueryRow(t.Context(), `SELECT object_key FROM attachments WHERE id = $1::bigint`, str(sz, "id")).Scan(&szKey)
	if err := st.Put(t.Context(), szKey, "text/plain", []byte("tamanho errado!")); err != nil {
		t.Fatal(err)
	}
	owner.sendWith(t, g.textID, "tamanho", []string{str(sz, "id")}, 422)
	if _, err := st.Stat(t.Context(), szKey); err != storage.ErrNotFound {
		t.Fatalf("o objeto com tamanho divergente deveria ter sido apagado: %v", err)
	}

	// magic bytes: HTML declarado como PNG passa pelo PUT assinado, mas a mensagem é recusada e o objeto, apagado
	html := []byte("<html><script>alert(document.cookie)</script></html>")
	fake := owner.requestUpload(t, g.textID, "inocente.png", "image/png", len(html), 201)
	put(t, fake, html)
	var fakeKey string
	_ = e.pool.QueryRow(t.Context(), `SELECT object_key FROM attachments WHERE id = $1::bigint`, str(fake, "id")).Scan(&fakeKey)
	b = owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "x", "attachment_ids": []string{str(fake, "id")}}, 422)
	if !strings.Contains(string(b), "não corresponde") {
		t.Fatalf("mensagem: %s", b)
	}
	if _, err := st.Stat(t.Context(), fakeKey); err != storage.ErrNotFound {
		t.Fatalf("o objeto com conteúdo divergente deveria ter sido apagado: %v", err)
	}
	var n int
	_ = e.pool.QueryRow(t.Context(), `SELECT count(*) FROM attachments WHERE id = $1::bigint`, str(fake, "id")).Scan(&n)
	if n != 0 {
		t.Fatal("a linha do anexo divergente deveria ter sido apagada")
	}

	// nenhuma mensagem foi criada pelas recusas
	hist := obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages?limit=100", nil, 200))
	for _, m := range list(hist, "messages") {
		if c := str(m, "content"); c == "reuso" || c == "dup" || c == "roubado" || c == "tamanho" || c == "expirado" {
			t.Fatalf("mensagem recusada foi gravada: %v", m)
		}
	}
}

func TestMessageAndAttachmentsAreAtomic(t *testing.T) {
	e := uploadsEnv(t)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Atomico")
	id := owner.upload(t, g.textID, "n.txt", "text/plain", []byte("nota"))

	// Duas mensagens disputando o mesmo anexo: exatamente uma vence, a outra não deixa mensagem para trás.
	results := make(chan int, 8)
	for i := 0; i < 8; i++ {
		go func() {
			resp, _ := owner.do(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "corrida", "attachment_ids": []string{id}})
			results <- resp.StatusCode
		}()
	}
	var created, rejected int
	for i := 0; i < 8; i++ {
		switch <-results {
		case 201:
			created++
		case 422:
			rejected++
		}
	}
	if created != 1 || rejected != 7 {
		t.Fatalf("201=%d 422=%d, esperado 1 e 7", created, rejected)
	}
	hist := obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages?limit=100", nil, 200))
	if n := len(list(hist, "messages")); n != 1 {
		t.Fatalf("deveria haver 1 mensagem, há %d", n)
	}
}

// ---------- limpeza de órfãos ----------

func TestOrphanCleanupJob(t *testing.T) {
	e := uploadsEnv(t)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Orfaos")
	st := testStorage(t)

	orphan := owner.upload(t, g.textID, "velho.txt", "text/plain", []byte("esquecido"))
	fresh := owner.upload(t, g.textID, "novo.txt", "text/plain", []byte("recente"))
	used := owner.upload(t, g.textID, "usado.txt", "text/plain", []byte("usado"))
	owner.sendWith(t, g.textID, "", []string{used}, 201)
	keys := map[string]string{}
	for _, id := range []string{orphan, fresh, used} {
		var k string
		if err := e.pool.QueryRow(t.Context(), `SELECT object_key FROM attachments WHERE id = $1::bigint`, id).Scan(&k); err != nil {
			t.Fatal(err)
		}
		keys[id] = k
	}
	// o órfão e o já usado envelheceram; só o órfão (sem mensagem) pode ser apagado
	if _, err := e.pool.Exec(t.Context(), `UPDATE attachments SET created_at = now() - interval '2 hours' WHERE id IN ($1::bigint, $2::bigint)`, orphan, used); err != nil {
		t.Fatal(err)
	}

	if _, err := e.app.jobs.Insert(t.Context(), attachment.CleanupArgs{}, nil); err != nil {
		t.Fatal(err)
	}
	waitUntil2(t, "órfão apagado", 15*time.Second, func() bool {
		var n int
		_ = e.pool.QueryRow(t.Context(), `SELECT count(*) FROM attachments WHERE id = $1::bigint`, orphan).Scan(&n)
		return n == 0
	})
	if _, err := st.Stat(t.Context(), keys[orphan]); err != storage.ErrNotFound {
		t.Fatalf("o objeto do órfão deveria ter sido apagado: %v", err)
	}
	for _, id := range []string{fresh, used} {
		var n int
		_ = e.pool.QueryRow(t.Context(), `SELECT count(*) FROM attachments WHERE id = $1::bigint`, id).Scan(&n)
		if _, err := st.Stat(t.Context(), keys[id]); n != 1 || err != nil {
			t.Fatalf("anexo %s não deveria ser apagado (linhas=%d, stat=%v)", id, n, err)
		}
	}
}

// ---------- DMs ----------

func TestDMAttachments(t *testing.T) {
	e := uploadsEnv(t)
	ana, bia, cris := e.newActor(t, "ana"), e.newActor(t, "bia"), e.newActor(t, "cris")
	friends(t, "Amigos", ana, bia, cris)
	dm := ana.openDM(t, bia.id, 201)
	dmID := str(dm, "id")
	wsBia, _ := bia.connectReady(t)

	// quem não participa da DM: 404 no upload e no envio
	cris.call(t, "POST", "/api/channels/"+dmID+"/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 5}, 404)

	id := ana.upload(t, dmID, "foto.png", "image/png", pngBytes(t, 640, 480, 255))
	cris.sendWith(t, dmID, "intruso", []string{id}, 404)
	msg := ana.sendWith(t, dmID, "olha", []string{id}, 201)
	if len(atts(msg)) != 1 {
		t.Fatalf("DM sem anexo: %v", msg)
	}
	created := payload(t, wsBia.event("MESSAGE_CREATE"))
	if len(atts(created)) != 1 {
		t.Fatalf("Bia não recebeu o anexo: %v", created)
	}
	up := atts(payload(t, wsBia.event("MESSAGE_UPDATE")))[0]
	b, _ := download(t, str(up, "thumbnail_url"))
	if cfg, _, err := image.DecodeConfig(bytes.NewReader(b)); err != nil || cfg.Width != 400 || cfg.Height != 300 {
		t.Fatalf("thumbnail da DM: %+v %v", cfg, err)
	}
	hist := obj(t, bia.call(t, "GET", "/api/channels/"+dmID+"/messages", nil, 200))
	if a := atts(list(hist, "messages")[0]); len(a) != 1 || str(a[0], "thumbnail_url") == "" {
		t.Fatalf("histórico da DM: %v", a)
	}
	cris.call(t, "GET", "/api/channels/"+dmID+"/messages", nil, 404)
}

// ---------- histórico sem N+1 ----------

// countingPool conta as idas ao banco da aplicação.
type countingPool struct {
	Pool
	n atomic.Int64
}

func (c *countingPool) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	c.n.Add(1)
	return c.Pool.Exec(ctx, sql, args...)
}

func (c *countingPool) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	c.n.Add(1)
	return c.Pool.Query(ctx, sql, args...)
}

func (c *countingPool) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	c.n.Add(1)
	return c.Pool.QueryRow(ctx, sql, args...)
}

func TestHistoryLoadsAttachmentsWithoutNPlusOne(t *testing.T) {
	var cp *countingPool
	e := newEnvWith(t, func(d *Deps) {
		bigLimits(d)
		d.UploadLimiter = ratelimit.New(100000, 100000)
		cp = &countingPool{Pool: d.Pool}
		d.Pool = cp // o pool embrulhado desliga os jobs (não são necessários aqui)
	})
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "SemNMaisUm")

	send := func(n int) {
		for i := 0; i < n; i++ {
			a := owner.upload(t, g.textID, fmt.Sprintf("a%d.txt", i), "text/plain", []byte("x"))
			b := owner.upload(t, g.textID, fmt.Sprintf("b%d.txt", i), "text/plain", []byte("y"))
			owner.sendWith(t, g.textID, "m", []string{a, b}, 201)
		}
	}
	queries := func() (int64, J) {
		before := cp.n.Load()
		h := obj(t, owner.call(t, "GET", "/api/channels/"+g.textID+"/messages?limit=100", nil, 200))
		return cp.n.Load() - before, h
	}

	send(2)
	few, h := queries()
	if len(list(h, "messages")) != 2 || len(atts(list(h, "messages")[0])) != 2 {
		t.Fatalf("histórico: %v", h)
	}
	send(18)
	many, h := queries()
	if len(list(h, "messages")) != 20 {
		t.Fatalf("mensagens: %d", len(list(h, "messages")))
	}
	for _, m := range list(h, "messages") {
		if len(atts(m)) != 2 {
			t.Fatalf("anexos faltando: %v", m)
		}
	}
	if few != many {
		t.Fatalf("o número de consultas depende do tamanho do histórico: %d (2 mensagens) vs %d (20 mensagens) — N+1", few, many)
	}
	t.Logf("consultas por GET do histórico: %d (2 e 20 mensagens, 2 anexos cada)", many)
}
