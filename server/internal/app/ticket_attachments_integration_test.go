//go:build integration

package app

import (
	"bytes"
	"strings"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/feedback"
	"github.com/devGustavoMuniz/spook/server/internal/platform/storage"
)

// requestTicketUpload pede a URL de PUT de uma imagem de chamado; ticketID vazio = chamado novo (rascunho).
func (a *actor) requestTicketUpload(t *testing.T, ticketID, filename, ct string, size, want int) J {
	t.Helper()
	body := J{"filename": filename, "content_type": ct, "size": size}
	if ticketID != "" {
		body["ticket_id"] = ticketID
	}
	return obj(t, a.call(t, "POST", "/api/tickets/uploads", body, want))
}

// uploadTicketImage pede a URL, envia o arquivo ao storage e devolve a resposta do pedido (id e ticket_id).
func (a *actor) uploadTicketImage(t *testing.T, ticketID string, body []byte) J {
	t.Helper()
	up := a.requestTicketUpload(t, ticketID, "captura.png", "image/png", len(body), 201)
	if resp := put(t, up, body); resp.StatusCode != 200 {
		t.Fatalf("PUT no storage = %d", resp.StatusCode)
	}
	return up
}

func TestTicketAttachmentsFlow(t *testing.T) {
	e := uploadsEnv(t)
	author, other, adm := e.newActor(t, "autor"), e.newActor(t, "outro"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	img := pngBytes(t, 120, 80, 255)

	// Abre o chamado com 2 capturas: o primeiro upload reserva o ID do chamado (rascunho).
	u1 := author.uploadTicketImage(t, "", img)
	draft := str(u1, "ticket_id")
	u2 := author.uploadTicketImage(t, draft, img)
	other.call(t, "POST", "/api/tickets/uploads", J{"ticket_id": draft, "filename": "a.png", "content_type": "image/png", "size": 10}, 404)
	tk := obj(t, author.call(t, "POST", "/api/tickets", J{
		"kind": "bug", "title": "Tela preta ao compartilhar", "description": "Veja as capturas",
		"draft_id": draft, "attachment_ids": []string{str(u1, "id"), str(u2, "id")},
	}, 201))
	id := str(tk, "id")
	if id != draft {
		t.Fatalf("o chamado deveria usar o ID do rascunho: %s != %s", id, draft)
	}
	as := list(list(tk, "messages")[0], "attachments")
	if len(as) != 2 || str(as[0], "content_type") != "image/png" {
		t.Fatalf("anexos da abertura = %v", tk["messages"])
	}
	if got, ct := download(t, str(as[0], "url")); !bytes.Equal(got, img) || ct != "image/png" {
		t.Fatalf("download: ct=%s", ct)
	}
	var key string
	if err := e.pool.QueryRow(t.Context(), `SELECT object_key FROM ticket_attachments WHERE id = $1::bigint`, str(u1, "id")).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(key, "tickets/"+id+"/") || !strings.HasSuffix(key, "/"+str(u1, "id")+".png") {
		t.Fatalf("chave do objeto = %q", key)
	}

	// Outro usuário comum não gera URL de upload nem lê o chamado.
	other.call(t, "POST", "/api/tickets/uploads", J{"ticket_id": id, "filename": "a.png", "content_type": "image/png", "size": 10}, 404)
	other.call(t, "GET", "/api/tickets/"+id, nil, 404)

	// Resposta do autor com 1 imagem.
	r := author.uploadTicketImage(t, id, img)
	msg := obj(t, author.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "outra captura", "attachment_ids": []string{str(r, "id")}}, 201))
	if len(list(msg, "attachments")) != 1 {
		t.Fatalf("resposta do autor = %v", msg)
	}
	// O mesmo anexo não serve duas vezes.
	author.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "de novo", "attachment_ids": []string{str(r, "id")}}, 422)

	// Admin: nota interna com imagem (invisível ao autor) e resposta pública com imagem (visível).
	n := adm.uploadTicketImage(t, id, img)
	adm.call(t, "POST", "/api/admin/tickets/"+id+"/messages", J{"body": "nota", "internal": true, "attachment_ids": []string{str(n, "id")}}, 201)
	pub := adm.uploadTicketImage(t, id, img)
	adm.call(t, "POST", "/api/admin/tickets/"+id+"/messages", J{"body": "resposta", "attachment_ids": []string{str(pub, "id")}}, 201)

	raw := string(author.call(t, "GET", "/api/tickets/"+id, nil, 200))
	if strings.Contains(raw, str(n, "id")) || !strings.Contains(raw, str(pub, "id")) {
		t.Fatalf("o autor deve ver a imagem pública e não a da nota: %s", raw)
	}
	detail := obj(t, adm.call(t, "GET", "/api/admin/tickets/"+id, nil, 200))
	total := 0
	for _, m := range list(detail, "messages") {
		total += len(list(m, "attachments"))
	}
	if total != 5 { // 2 na abertura + 1 do autor + nota + resposta pública
		t.Fatalf("o admin deveria ver 5 imagens, viu %d", total)
	}
}

func TestTicketAttachmentsRejections(t *testing.T) {
	e := uploadsEnv(t)
	st := testStorage(t)
	author := e.newActor(t, "autor")
	tk := newTicket(t, author, "Chamado para rejeições")
	id := str(tk, "id")

	// Tipo, tamanho e extensão: recusados já no pedido.
	author.requestTicketUpload(t, id, "a.gif", "image/gif", 10, 422)
	author.requestTicketUpload(t, id, "a.pdf", "application/pdf", 10, 422)
	author.requestTicketUpload(t, id, "a.png", "image/png", feedback.MaxAttachmentBytes+1, 422)
	author.requestTicketUpload(t, id, "a.png", "image/png", 0, 422)
	author.requestTicketUpload(t, id, "a.jpg", "image/png", 10, 422)

	// Magic bytes: um HTML enviado como image/png é recusado ao anexar, e o objeto some.
	fake := []byte("<html><script>alert(1)</script></html>")
	up := author.uploadTicketImage(t, id, fake)
	var key string
	_ = e.pool.QueryRow(t.Context(), `SELECT object_key FROM ticket_attachments WHERE id = $1::bigint`, str(up, "id")).Scan(&key)
	author.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "x", "attachment_ids": []string{str(up, "id")}}, 422)
	if _, err := st.Stat(t.Context(), key); err != storage.ErrNotFound {
		t.Fatalf("o objeto recusado deveria ter sido apagado: %v", err)
	}

	// Não enviado ao storage; mais de 3 por mensagem.
	pending := author.requestTicketUpload(t, id, "a.png", "image/png", 10, 201)
	author.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "x", "attachment_ids": []string{str(pending, "id")}}, 422)
	author.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "x", "attachment_ids": []string{"1", "2", "3", "4"}}, 422)
	author.call(t, "POST", "/api/tickets/uploads", J{"filename": "a.png", "content_type": "image/png", "size": 10, "ticket_id": "abc"}, 404)
}

func TestTicketAttachmentOrphansAreCleaned(t *testing.T) {
	e := uploadsEnv(t)
	st := testStorage(t)
	author := e.newActor(t, "autor")
	old := author.uploadTicketImage(t, "", pngBytes(t, 10, 10, 255))
	fresh := author.uploadTicketImage(t, "", pngBytes(t, 10, 10, 255))
	var oldKey string
	_ = e.pool.QueryRow(t.Context(), `SELECT object_key FROM ticket_attachments WHERE id = $1::bigint`, str(old, "id")).Scan(&oldKey)
	if _, err := e.pool.Exec(t.Context(), `UPDATE ticket_attachments SET created_at = now() - interval '2 hours' WHERE id = $1::bigint`, str(old, "id")); err != nil {
		t.Fatal(err)
	}
	if _, err := e.app.jobs.Insert(t.Context(), feedback.CleanupArgs{}, nil); err != nil {
		t.Fatal(err)
	}
	waitUntil2(t, "órfão de chamado apagado", 15*time.Second, func() bool {
		var n int
		_ = e.pool.QueryRow(t.Context(), `SELECT count(*) FROM ticket_attachments WHERE id = $1::bigint`, str(old, "id")).Scan(&n)
		return n == 0
	})
	if _, err := st.Stat(t.Context(), oldKey); err != storage.ErrNotFound {
		t.Fatalf("o objeto do órfão deveria ter sido apagado: %v", err)
	}
	var n int
	_ = e.pool.QueryRow(t.Context(), `SELECT count(*) FROM ticket_attachments WHERE id = $1::bigint`, str(fresh, "id")).Scan(&n)
	if n != 1 {
		t.Fatal("o anexo recente não pode ser apagado")
	}
}
