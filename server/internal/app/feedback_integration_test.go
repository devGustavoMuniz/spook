//go:build integration

package app

import (
	"net/url"
	"strings"
	"testing"
	"time"
)

// ticketEvent lê até chegar um TICKET_UPDATE da equipe (by_admin) sobre o chamado id; os eventos das ações do
// próprio autor, que também chegam, são pulados.
func (c *wsClient) ticketEvent(id string) J {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, "TICKET_UPDATE") {
			if p := payload(c.t, f); str(p, "id") == id && p["by_admin"] == true {
				return p
			}
		}
	}
	c.t.Fatalf("TICKET_UPDATE de %s não chegou", id)
	return nil
}

func newTicket(t *testing.T, a *actor, title string) J {
	t.Helper()
	return obj(t, a.call(t, "POST", "/api/tickets", J{
		"kind": "bug", "title": title, "description": "Descrição detalhada do problema",
		"context": J{"app_version": "0.1.6", "client": "web", "route": "/channels/1"},
	}, 201))
}

func TestTicketsRequireAuthAndValidate(t *testing.T) {
	e := newEnv(t)
	a := e.newActor(t, "autor")
	for _, r := range [][2]string{{"GET", "/api/tickets"}, {"POST", "/api/tickets"}, {"GET", "/api/tickets/1"}, {"POST", "/api/tickets/1/messages"}, {"PUT", "/api/tickets/1/status"}} {
		resp, b := e.do(t, r[0], r[1], nil, nil)
		status(t, resp, b, 401)
	}
	a.call(t, "POST", "/api/tickets", J{"kind": "bug", "title": "ab", "description": "x"}, 422)
	a.call(t, "POST", "/api/tickets", J{"kind": "lixo", "title": "Título", "description": "x"}, 422)
	a.call(t, "POST", "/api/tickets", J{"kind": "bug", "title": "Título", "description": ""}, 422)
	a.call(t, "POST", "/api/tickets", J{"kind": "bug", "title": "Título", "description": strings.Repeat("a", 4001)}, 422)
	a.call(t, "GET", "/api/tickets?cursor=lixo", nil, 422)
	a.call(t, "GET", "/api/tickets?status=lixo", nil, 422)
	a.call(t, "GET", "/api/tickets/abc", nil, 404)
	a.call(t, "GET", "/api/tickets/999999999999", nil, 404)
}

// O autor só vê os próprios chamados; a nota interna nunca chega a ele; o admin vê tudo e responde.
func TestTicketsAuthorizationAndInternalNotes(t *testing.T) {
	e := newEnv(t)
	a, b, adm := e.newActor(t, "autor"), e.newActor(t, "outro"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	tk := newTicket(t, a, "A voz cai ao compartilhar tela")
	ac, _ := a.connectReady(t) // conecta depois de criar: o evento da própria criação não entra na leitura
	id := str(tk, "id")
	if str(tk, "status") != "open" || len(list(tk, "messages")) != 1 || str(tk, "kind") != "bug" {
		t.Fatalf("chamado criado = %v", tk)
	}

	// Outra pessoa: lista vazia e 404 em tudo (não revela a existência).
	if items := list(obj(t, b.call(t, "GET", "/api/tickets", nil, 200)), "items"); len(items) != 0 {
		t.Fatalf("lista de outro usuário = %v", items)
	}
	b.call(t, "GET", "/api/tickets/"+id, nil, 404)
	b.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "intruso"}, 404)
	b.call(t, "PUT", "/api/tickets/"+id+"/status", J{"status": "closed"}, 404)

	// Rotas de admin: 401/403 para quem não é.
	resp, body := e.do(t, "GET", "/api/admin/tickets", nil, nil)
	status(t, resp, body, 401)
	for _, r := range [][3]string{
		{"GET", "/api/admin/tickets", ""}, {"GET", "/api/admin/tickets/summary", ""}, {"GET", "/api/admin/tickets/" + id, ""},
		{"POST", "/api/admin/tickets/" + id + "/messages", "x"}, {"PUT", "/api/admin/tickets/" + id + "/status", "x"},
	} {
		var payload any
		switch r[0] {
		case "POST":
			payload = J{"body": "x"}
		case "PUT":
			payload = J{"status": "closed"}
		}
		for _, who := range []*actor{a, b} {
			if out := who.call(t, r[0], r[1], payload, 403); !strings.Contains(string(out), "administradores") {
				t.Fatalf("403 deve ser genérico: %s", out)
			}
		}
	}

	// Admin: nota interna, depois resposta pública.
	adm.call(t, "POST", "/api/admin/tickets/"+id+"/messages", J{"body": "SEGREDO-INTERNO suspeito do mic", "internal": true}, 201)
	ac.none(300 * time.Millisecond) // a nota não avisa o autor
	detail := obj(t, adm.call(t, "GET", "/api/admin/tickets/"+id, nil, 200))
	if str(detail, "status") != "open" || len(list(detail, "messages")) != 2 {
		t.Fatalf("a nota não deveria mudar o estado: %v", detail)
	}
	au := obj2(detail, "author")
	if str(au, "username") != a.name || !strings.Contains(str(au, "email"), "@") || str(obj2(detail, "context"), "route") != "/channels/1" {
		t.Fatalf("autor/contexto no admin = %v", detail)
	}
	adm.call(t, "POST", "/api/admin/tickets/"+id+"/messages", J{"body": "Obrigado, estamos olhando."}, 201)
	ev := ac.ticketEvent(id)
	if str(ev, "status") != "answered" || ev["unread"] != true || ev["by_admin"] != true {
		t.Fatalf("TICKET_UPDATE = %v", ev)
	}

	// O autor vê só a conversa pública, sem identificar o admin; abrir marca como lido.
	if items := list(obj(t, a.call(t, "GET", "/api/tickets", nil, 200)), "items"); len(items) != 1 || items[0]["unread"] != true {
		t.Fatalf("lista do autor = %v", items)
	}
	raw := string(a.call(t, "GET", "/api/tickets/"+id, nil, 200))
	if strings.Contains(raw, "SEGREDO") || strings.Contains(raw, "internal") || strings.Contains(raw, adm.name) || strings.Contains(raw, adm.id) {
		t.Fatalf("vazou dado interno para o autor: %s", raw)
	}
	if got := obj(t, a.call(t, "GET", "/api/tickets/"+id, nil, 200)); got["unread"] != false || len(list(got, "messages")) != 2 || str(got, "status") != "answered" {
		t.Fatalf("depois de abrir = %v", got)
	}

	// O autor responde → volta a aberto; fecha; não responde fechado; reabre.
	a.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "Acontece só no Windows."}, 201)
	if st := str(obj(t, a.call(t, "GET", "/api/tickets/"+id, nil, 200)), "status"); st != "open" {
		t.Fatalf("estado depois da resposta do autor = %s", st)
	}
	a.call(t, "PUT", "/api/tickets/"+id+"/status", J{"status": "closed"}, 200)
	a.call(t, "POST", "/api/tickets/"+id+"/messages", J{"body": "ainda?"}, 409)
	a.call(t, "PUT", "/api/tickets/"+id+"/status", J{"status": "resolved"}, 422)
	a.call(t, "PUT", "/api/tickets/"+id+"/status", J{"status": "open"}, 200)
	a.call(t, "PUT", "/api/tickets/"+id+"/status", J{"status": "open"}, 409)

	// Admin muda o estado: resolver avisa o autor.
	adm.call(t, "PUT", "/api/admin/tickets/"+id+"/status", J{"status": "lixo"}, 422)
	out := obj(t, adm.call(t, "PUT", "/api/admin/tickets/"+id+"/status", J{"status": "resolved"}, 200))
	if str(out, "status") != "resolved" || out["unread"] != true {
		t.Fatalf("resolvido = %v", out)
	}
	if ev := ac.ticketEvent(id); str(ev, "status") != "resolved" || ev["by_admin"] != true {
		t.Fatalf("evento de resolvido = %v", ev)
	}
}

func TestAdminTicketQueueFiltersSearchSortAndPagination(t *testing.T) {
	e := newEnv(t)
	a, b, adm := e.newActor(t, "ana"), e.newActor(t, "beto"), e.newActor(t, "adm")
	e.makeAdmin(t, adm)
	marker := "zq" + strings.ReplaceAll(a.id, "_", "")
	var ids []string
	for i, title := range []string{marker + " primeiro", marker + " segundo", marker + " terceiro"} {
		kind := "bug"
		if i == 1 {
			kind = "suggestion"
		}
		src := a
		if i == 2 {
			src = b
		}
		ids = append(ids, str(obj(t, src.call(t, "POST", "/api/tickets", J{"kind": kind, "title": title, "description": "d"}, 201)), "id"))
	}
	q := func(extra string) J {
		return obj(t, adm.call(t, "GET", "/api/admin/tickets?q="+url.QueryEscape(marker)+extra, nil, 200))
	}
	if got := list(q(""), "items"); len(got) != 3 {
		t.Fatalf("busca por título = %d", len(got))
	}
	if got := list(q("&kind=suggestion"), "items"); len(got) != 1 || str(got[0], "id") != ids[1] {
		t.Fatalf("filtro por tipo = %v", got)
	}
	adm.call(t, "PUT", "/api/admin/tickets/"+ids[0]+"/status", J{"status": "in_review"}, 200)
	if got := list(q("&status=in_review"), "items"); len(got) != 1 || str(got[0], "id") != ids[0] {
		t.Fatalf("filtro por estado = %v", got)
	}
	// Busca pelo username do autor.
	if got := list(obj(t, adm.call(t, "GET", "/api/admin/tickets?q="+url.QueryEscape(b.name), nil, 200)), "items"); len(got) < 1 || str(got[0], "id") != ids[2] {
		t.Fatalf("busca por autor = %v", got)
	}
	// Curingas do LIKE são literais.
	if got := list(obj(t, adm.call(t, "GET", "/api/admin/tickets?q=%25", nil, 200)), "items"); len(got) != 0 {
		t.Fatalf("%% deveria ser literal: %v", got)
	}
	// Ordenação: oldest = pela criação; activity = o movimento mais recente primeiro (o em análise subiu).
	old := list(q("&sort=oldest"), "items")
	if len(old) != 3 || str(old[0], "id") != ids[0] || str(old[2], "id") != ids[2] {
		t.Fatalf("oldest = %v", old)
	}
	act := list(q("&sort=activity"), "items")
	if len(act) != 3 || str(act[0], "id") != ids[0] || str(act[1], "id") != ids[2] {
		t.Fatalf("activity = %v", act)
	}
	adm.call(t, "GET", "/api/admin/tickets?sort=lixo", nil, 422)
	adm.call(t, "GET", "/api/admin/tickets?cursor=lixo", nil, 422)

	// Paginação por cursor nas duas ordenações: sem repetir nem pular.
	for _, sort := range []string{"activity", "oldest"} {
		var seen []string
		cursor := ""
		for page := 0; page < 5; page++ {
			p := q("&sort=" + sort + "&limit=2&cursor=" + url.QueryEscape(cursor))
			for _, it := range list(p, "items") {
				seen = append(seen, str(it, "id"))
			}
			nc, _ := p["next_cursor"].(string)
			if nc == "" {
				break
			}
			cursor = nc
		}
		if len(seen) != 3 || seen[0] == seen[1] || seen[1] == seen[2] || seen[0] == seen[2] {
			t.Fatalf("paginação %s = %v", sort, seen)
		}
	}
	s := obj(t, adm.call(t, "GET", "/api/admin/tickets/summary", nil, 200))
	if num(s, "total") < 3 || num(s, "in_review") < 1 || num(s, "open") < 2 {
		t.Fatalf("resumo = %v", s)
	}
}

func TestTicketLimitsAndRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) { d.ActionLimiters = nil }) // limites de produção
	a := e.newActor(t, "rapido")
	for i := 0; i < 5; i++ {
		newTicket(t, a, "Chamado numero "+string(rune('A'+i)))
	}
	resp, body := a.do(t, "POST", "/api/tickets", J{"kind": "bug", "title": "Sexto", "description": "x"})
	status(t, resp, body, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
	// Outra pessoa não é afetada.
	newTicket(t, e.newActor(t, "calmo"), "Meu chamado")
}

func TestTicketActiveLimitPerUser(t *testing.T) {
	e := newEnv(t)
	a := e.newActor(t, "muitos")
	for i := 0; i < 20; i++ {
		newTicket(t, a, "Chamado em andamento")
	}
	a.call(t, "POST", "/api/tickets", J{"kind": "bug", "title": "Vigésimo primeiro", "description": "x"}, 409)
	// Fechar um libera espaço.
	items := list(obj(t, a.call(t, "GET", "/api/tickets?limit=1", nil, 200)), "items")
	a.call(t, "PUT", "/api/tickets/"+str(items[0], "id")+"/status", J{"status": "closed"}, 200)
	newTicket(t, a, "Agora cabe")
}
