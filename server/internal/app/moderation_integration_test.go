//go:build integration

package app

import (
	"strings"
	"testing"
	"time"

	lk "github.com/livekit/protocol/livekit"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

func modCfg(d *Deps) {
	gwCfg(d)
	d.AuthLimiter = ratelimit.New(100000, 100000)
	d.ModLimiter = ratelimit.New(100000, 100000)
}

// setRolePerms dá ao usuário um cargo novo (na posição pos) com as permissões dadas.
func (a *actor) grantRole(t *testing.T, guildID string, target *actor, name string, pos int, p perm.Perm) string {
	t.Helper()
	r := a.role(t, guildID, J{"name": name, "position": pos, "permissions": int64(p)})
	a.giveRole(t, guildID, target.id, str(r, "id"))
	return str(r, "id")
}

func (a *actor) auditLog(t *testing.T, guildID, query string, want int) J {
	t.Helper()
	b := a.call(t, "GET", "/api/guilds/"+guildID+"/audit-logs"+query, nil, want)
	if want != 200 {
		return nil
	}
	return obj(t, b)
}

func hasAudit(entries []J, action, targetID string) J {
	for _, e := range entries {
		if str(e, "action") == action && (targetID == "" || str(e, "target_id") == targetID) {
			return e
		}
	}
	return nil
}

// ---------- banimentos ----------

func TestBanFlow(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner, mod, peer, victim, stranger := e.newActor(t, "dono"), e.newActor(t, "mod"), e.newActor(t, "par"), e.newActor(t, "vitima"), e.newActor(t, "estranho")
	g := owner.createGuild(t, "Moderado")
	for _, u := range []*actor{mod, peer, victim} {
		u.join(t, owner, g.id)
	}
	owner.grantRole(t, g.id, mod, "moderador", 10, perm.BanMembers)
	owner.grantRole(t, g.id, peer, "moderador-par", 10, perm.BanMembers)
	base := "/api/guilds/" + g.id

	// 401, 404 e 403: sem sessão, não-membro e sem a permissão.
	resp, b := e.do(t, "PUT", base+"/bans/"+victim.id, J{}, nil)
	status(t, resp, b, 401)
	stranger.call(t, "PUT", base+"/bans/"+victim.id, J{}, 404)
	victim.call(t, "PUT", base+"/bans/"+peer.id, J{}, 403)
	victim.call(t, "GET", base+"/bans", nil, 403)
	victim.call(t, "DELETE", base+"/bans/"+peer.id, nil, 403)

	// Regras: a si mesmo, o dono, cargo igual, motivo grande demais, usuário inexistente.
	mod.call(t, "PUT", base+"/bans/"+mod.id, J{}, 422)
	mod.call(t, "PUT", base+"/bans/"+owner.id, J{}, 403)
	mod.call(t, "PUT", base+"/bans/"+peer.id, J{}, 403) // mesmo nível na hierarquia
	mod.call(t, "PUT", base+"/bans/"+victim.id, J{"reason": strings.Repeat("a", 513)}, 422)
	mod.call(t, "PUT", base+"/bans/999999999999", J{}, 404)
	mod.call(t, "PUT", base+"/bans/abc", J{}, 404)
	owner.call(t, "PUT", base+"/bans/"+owner.id, J{}, 422)

	// A vítima está conectada ao gateway e recebe o servidor sumindo.
	ws := victim.connect(t)
	ws.identify()
	ownerWS := owner.connect(t)
	ownerWS.identify()

	mod.call(t, "PUT", base+"/bans/"+victim.id, J{"reason": "spam de links"}, 204)
	if f := ws.event("GUILD_DELETE"); str(payload(t, f), "id") != g.id {
		t.Fatalf("GUILD_DELETE: %s", f.D)
	}
	ownerWS.event("GUILD_MEMBER_REMOVE")

	// Já não é membro e para de receber o servidor.
	victim.call(t, "GET", base, nil, 404)
	victim.call(t, "GET", "/api/channels/"+g.textID+"/messages", nil, 404)
	owner.call(t, "POST", "/api/channels/"+g.textID+"/messages", J{"content": "depois do ban"}, 201)
	ws.noChannelEvents(400 * time.Millisecond)

	// Lista com motivo, autor e paginação.
	l := obj(t, mod.call(t, "GET", base+"/bans", nil, 200))
	bans := list(l, "bans")
	if len(bans) != 1 || str(bans[0], "user_id") != victim.id || str(bans[0], "reason") != "spam de links" || str(bans[0], "banned_by") != mod.id {
		t.Fatalf("lista de bans: %v", l)
	}
	if l["has_more"] != false {
		t.Fatalf("has_more: %v", l)
	}

	// Reentrada por convite: 403 com code "banned" (não consome uso).
	code := owner.invite(t, g.id)
	resp, b = victim.do(t, "POST", "/api/invites/"+code, nil)
	status(t, resp, b, 403)
	if m := obj(t, b); str(m, "code") != "banned" {
		t.Fatalf("code do 403 = %v", m)
	}

	// Banir quem nunca entrou / já saiu (por ID), e idempotência do ban.
	stranger2 := e.newActor(t, "saiu")
	mod.call(t, "PUT", base+"/bans/"+stranger2.id, J{}, 204)
	mod.call(t, "PUT", base+"/bans/"+victim.id, J{"reason": "reincidente"}, 204)
	resp, b = stranger2.do(t, "POST", "/api/invites/"+code, nil)
	status(t, resp, b, 403)
	if got := list(obj(t, mod.call(t, "GET", base+"/bans", nil, 200)), "bans"); len(got) != 2 {
		t.Fatalf("bans: %v", got)
	}
	if got := list(obj(t, mod.call(t, "GET", base+"/bans?limit=1", nil, 200)), "bans"); len(got) != 1 {
		t.Fatalf("limit: %v", got)
	}

	// Auditoria: quem baniu, o alvo e o motivo.
	log := owner.auditLog(t, g.id, "?action=member.ban", 200)
	ent := hasAudit(list(log, "entries"), "member.ban", victim.id)
	if ent == nil || str(ent, "reason") == "" || str(sub(ent, "actor"), "id") != mod.id {
		t.Fatalf("auditoria do ban: %v", log)
	}

	// Desbanir: 204, depois 404; a pessoa volta com um convite novo.
	peer.call(t, "DELETE", base+"/bans/"+victim.id, nil, 204)
	peer.call(t, "DELETE", base+"/bans/"+victim.id, nil, 404)
	victim.call(t, "POST", "/api/invites/"+code, nil, 200)
	if hasAudit(list(owner.auditLog(t, g.id, "", 200), "entries"), "member.unban", victim.id) == nil {
		t.Fatal("unban sem auditoria")
	}
}

func sub(m J, k string) J {
	v, _ := m[k].(map[string]any)
	return v
}

func TestBanRevokesChannelOverwritesAndHierarchyForAdministrator(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner, admin, high, member := e.newActor(t, "dono"), e.newActor(t, "adm"), e.newActor(t, "alto"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Hierarquia")
	for _, u := range []*actor{admin, high, member} {
		u.join(t, owner, g.id)
	}
	owner.grantRole(t, g.id, admin, "administrador", 5, perm.Administrator)
	owner.grantRole(t, g.id, high, "alto", 9, perm.ViewChannel)
	base := "/api/guilds/" + g.id
	// Administrador tem BAN_MEMBERS, mas NÃO age sobre cargo superior.
	admin.call(t, "PUT", base+"/bans/"+high.id, J{}, 403)
	admin.call(t, "PUT", base+"/bans/"+owner.id, J{}, 403)
	admin.call(t, "PUT", base+"/bans/"+member.id, J{}, 204)

	// Overwrite pessoal some quando a pessoa sai (volta sem acesso ao canal privado).
	ch := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "secreto"}, 201))
	cid := str(ch, "id")
	owner.call(t, "PUT", "/api/channels/"+cid+"/overwrites/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 200)
	owner.call(t, "PUT", "/api/channels/"+cid+"/overwrites/member/"+high.id, J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)
	high.call(t, "GET", "/api/channels/"+cid+"/messages", nil, 200)
	high.call(t, "DELETE", base+"/members/@me", nil, 204)
	high.join(t, owner, g.id)
	high.call(t, "GET", "/api/channels/"+cid+"/messages", nil, 403)
}

// ---------- apelido ----------

func TestNicknameRules(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner, mod, member, other, stranger := e.newActor(t, "dono"), e.newActor(t, "mod"), e.newActor(t, "membro"), e.newActor(t, "outro"), e.newActor(t, "estranho")
	g := owner.createGuild(t, "Apelidos")
	for _, u := range []*actor{mod, member, other} {
		u.join(t, owner, g.id)
	}
	owner.grantRole(t, g.id, mod, "apelidos", 10, perm.ManageNicknames)
	base := "/api/guilds/" + g.id

	// O próprio membro muda o seu (CHANGE_NICKNAME está no @everyone) e o evento chega aos outros.
	ws := other.connect(t)
	ws.identify()
	m := obj(t, member.call(t, "PATCH", base+"/members/@me/nick", J{"nick": "  Fantasma  "}, 200))
	if str(m, "nickname") != "Fantasma" {
		t.Fatalf("apelido: %v", m)
	}
	if ev := payload(t, ws.event("GUILD_MEMBER_UPDATE")); str(ev, "nickname") != "Fantasma" || str(ev, "user_id") != member.id {
		t.Fatalf("GUILD_MEMBER_UPDATE: %v", ev)
	}
	// Aparece na lista de membros.
	found := false
	for _, mm := range list(obj(t, other.call(t, "GET", base+"/members", nil, 200)), "members") {
		if str(mm, "user_id") == member.id && str(mm, "nickname") == "Fantasma" {
			found = true
		}
	}
	if !found {
		t.Fatal("apelido fora da lista de membros")
	}

	// Limites: 1–32, sem controle; vazio/nulo remove.
	member.call(t, "PATCH", base+"/members/@me/nick", J{"nick": strings.Repeat("a", 33)}, 422)
	member.call(t, "PATCH", base+"/members/@me/nick", J{"nick": "a\u0007b"}, 422)
	member.call(t, "PATCH", base+"/members/@me/nick", J{"nick": strings.Repeat("ç", 32)}, 200)
	if m := obj(t, member.call(t, "PATCH", base+"/members/@me/nick", J{"nick": nil}, 200)); m["nickname"] != nil {
		t.Fatalf("apelido deveria sumir: %v", m)
	}
	stranger.call(t, "PATCH", base+"/members/@me/nick", J{"nick": "x"}, 404)

	// Sem CHANGE_NICKNAME o próprio membro não muda; sem MANAGE_NICKNAMES não mexe nos outros.
	owner.call(t, "PATCH", base+"/roles/"+g.id, J{"permissions": int64(perm.DefaultEveryone &^ perm.ChangeNickname)}, 200)
	member.call(t, "PATCH", base+"/members/@me/nick", J{"nick": "novo"}, 403)
	other.call(t, "PATCH", base+"/members/"+member.id+"/nick", J{"nick": "xx"}, 403)

	// Moderador muda o de outro, com auditoria; hierarquia vale (não mexe no dono nem em cargo igual/maior).
	mod.call(t, "PATCH", base+"/members/"+member.id+"/nick", J{"nick": "Renomeado"}, 200)
	mod.call(t, "PATCH", base+"/members/"+owner.id+"/nick", J{"nick": "usurpador"}, 403)
	mod.call(t, "PATCH", base+"/members/999999999/nick", J{"nick": "x"}, 404)
	e1 := hasAudit(list(owner.auditLog(t, g.id, "", 200), "entries"), "member.nick_update", member.id)
	if e1 == nil {
		t.Fatal("apelido alterado por outro deveria constar na auditoria")
	}
	// Mudar o próprio apelido NÃO entra na auditoria.
	owner.call(t, "PATCH", base+"/members/@me/nick", J{"nick": "Chefe"}, 200)
	if hasAudit(list(owner.auditLog(t, g.id, "", 200), "entries"), "member.nick_update", owner.id) != nil {
		t.Fatal("o próprio apelido não deveria ser auditado")
	}
	// Um moderador sem hierarquia sobre outro moderador.
	mod2 := e.newActor(t, "mod2")
	mod2.join(t, owner, g.id)
	owner.grantRole(t, g.id, mod2, "apelidos-2", 10, perm.ManageNicknames)
	mod.call(t, "PATCH", base+"/members/"+mod2.id+"/nick", J{"nick": "x"}, 403)
}

// ---------- canais privados e overwrites ----------

func TestPrivateChannelOverwrites(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner, vip, plain, mgr, stranger := e.newActor(t, "dono"), e.newActor(t, "vip"), e.newActor(t, "comum"), e.newActor(t, "gerente"), e.newActor(t, "estranho")
	g := owner.createGuild(t, "Privado")
	for _, u := range []*actor{vip, plain, mgr} {
		u.join(t, owner, g.id)
	}
	base := "/api/guilds/" + g.id
	vipRole := owner.role(t, g.id, J{"name": "vip", "position": 3, "permissions": 0})
	owner.giveRole(t, g.id, vip.id, str(vipRole, "id"))
	owner.grantRole(t, g.id, mgr, "gerente", 5, perm.ManageChannels)

	priv := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "diretoria"}, 201))
	pid := str(priv, "id")
	ow := "/api/channels/" + pid + "/overwrites"

	// Conectados antes de o canal virar privado.
	vipWS, plainWS := vip.connect(t), plain.connect(t)
	vipWS.identify()
	plainWS.identify()
	owner.call(t, "POST", "/api/channels/"+pid+"/messages", J{"content": "público por enquanto"}, 201)
	plainWS.event("MESSAGE_CREATE")
	vipWS.event("MESSAGE_CREATE")

	// Quem não gerencia canais não edita overwrites; forasteiro nem enxerga o canal.
	plain.call(t, "PUT", ow+"/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 403)
	plain.call(t, "GET", ow, nil, 403)
	stranger.call(t, "GET", ow, nil, 404)
	// Validações do corpo.
	owner.call(t, "PUT", ow+"/role/"+g.id, J{"allow": int64(perm.ViewChannel), "deny": int64(perm.ViewChannel)}, 422)
	owner.call(t, "PUT", ow+"/role/"+g.id, J{"allow": int64(perm.BanMembers), "deny": 0}, 422) // não é permissão de canal
	owner.call(t, "PUT", ow+"/role/"+g.id, J{"allow": 0, "deny": int64(1) << 40}, 422)
	owner.call(t, "PUT", ow+"/thing/"+g.id, J{"allow": 0, "deny": 0}, 422)
	owner.call(t, "PUT", ow+"/role/987654321", J{"allow": 0, "deny": 1 << 6}, 404)
	owner.call(t, "PUT", ow+"/member/"+owner.id, J{"allow": 0, "deny": 1 << 6}, 422) // o dono ignora overwrites

	// Canal privado: nega VIEW ao @everyone e libera ao cargo vip.
	owner.call(t, "PUT", ow+"/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 200)
	owner.call(t, "PUT", ow+"/role/"+str(vipRole, "id"), J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)

	// Gateway: quem perdeu a visão recebe CHANNEL_DELETE e nunca mais as mensagens; o vip segue recebendo.
	if f := plainWS.event("CHANNEL_DELETE"); str(payload(t, f), "id") != pid {
		t.Fatalf("CHANNEL_DELETE: %s", f.D)
	}
	owner.call(t, "POST", "/api/channels/"+pid+"/messages", J{"content": "segredo"}, 201)
	if f := vipWS.event("MESSAGE_CREATE"); !strings.Contains(string(f.D), "segredo") {
		t.Fatalf("vip deveria receber: %s", f.D)
	}
	plainWS.noChannelEvents(500 * time.Millisecond)

	// REST: lista de canais, leitura, envio, digitando, pins e voz.
	for _, c := range list(map[string]any{"c": toAny(arr(t, plain.call(t, "GET", base+"/channels", nil, 200)))}, "c") {
		if str(c, "id") == pid {
			t.Fatalf("canal privado na lista do comum: %v", c)
		}
	}
	found := false
	for _, c := range arr(t, vip.call(t, "GET", base+"/channels", nil, 200)) {
		found = found || str(c, "id") == pid
	}
	if !found {
		t.Fatal("vip deveria ver o canal")
	}
	plain.call(t, "GET", "/api/channels/"+pid+"/messages", nil, 403)
	plain.call(t, "POST", "/api/channels/"+pid+"/messages", J{"content": "x"}, 403)
	plain.call(t, "POST", "/api/channels/"+pid+"/typing", nil, 403)
	plain.call(t, "GET", "/api/channels/"+pid+"/pins", nil, 403)
	plain.call(t, "GET", "/api/channels/"+pid+"/my-permissions", nil, 403)
	vip.call(t, "GET", "/api/channels/"+pid+"/messages", nil, 200)
	if p := obj(t, vip.call(t, "GET", "/api/channels/"+pid+"/my-permissions", nil, 200)); num(p, "permissions")&int64(perm.ViewChannel) == 0 {
		t.Fatalf("my-permissions do vip: %v", p)
	}
	// O comum nem aparece em GET /api/guilds e READY.
	for _, d := range arr(t, plain.call(t, "GET", "/api/guilds", nil, 200)) {
		for _, c := range list(d, "channels") {
			if str(c, "id") == pid {
				t.Fatalf("canal privado em GET /guilds do comum")
			}
		}
	}
	ws2 := plain.connect(t)
	_, ready := ws2.identify()
	for _, gg := range list(ready, "guilds") {
		for _, c := range list(gg, "channels") {
			if str(c, "id") == pid {
				t.Fatal("canal privado no READY do comum")
			}
		}
	}

	// O gerente (posição 5) não vê o canal privado (sem VIEW): ele "não existe" para ele (404).
	mgr.call(t, "PUT", ow+"/role/"+str(vipRole, "id"), J{"allow": int64(perm.ViewChannel | perm.ManageMessages), "deny": 0}, 404)
	mgr.call(t, "GET", ow, nil, 404)
	// Libera o gerente por membro e testa o limite de concessão: ele tem VIEW, SEND... mas não MANAGE_MESSAGES.
	owner.call(t, "PUT", ow+"/member/"+mgr.id, J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)
	mgr.call(t, "GET", ow, nil, 200)
	mgr.call(t, "PUT", ow+"/role/"+str(vipRole, "id"), J{"allow": int64(perm.ViewChannel | perm.SendMessages), "deny": 0}, 200)
	mgr.call(t, "PUT", ow+"/role/"+str(vipRole, "id"), J{"allow": int64(perm.ViewChannel | perm.ManageMessages), "deny": 0}, 403)
	// Cargo acima dele: intocável.
	boss := owner.role(t, g.id, J{"name": "chefe", "position": 8, "permissions": 0})
	mgr.call(t, "PUT", ow+"/role/"+str(boss, "id"), J{"allow": 0, "deny": int64(perm.SendMessages)}, 403)
	// O @everyone pode (não tem hierarquia), desde que não conceda o que não tem.
	mgr.call(t, "PUT", ow+"/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel | perm.AttachFiles)}, 200)

	// Lista de overwrites e remoção: volta a ficar público.
	if got := arr(t, owner.call(t, "GET", ow, nil, 200)); len(got) != 3 {
		t.Fatalf("overwrites: %v", got)
	}
	owner.call(t, "DELETE", ow+"/role/"+g.id, nil, 204)
	if f := plainWS.event("CHANNEL_CREATE"); str(payload(t, f), "id") != pid {
		t.Fatalf("CHANNEL_CREATE ao voltar a ver: %s", f.D)
	}
	plain.call(t, "GET", "/api/channels/"+pid+"/messages", nil, 200)
	// Auditoria dos overwrites.
	if hasAudit(list(owner.auditLog(t, g.id, "?action=channel.overwrite_update", 200), "entries"), "channel.overwrite_update", pid) == nil {
		t.Fatal("overwrite sem auditoria")
	}
	if hasAudit(list(owner.auditLog(t, g.id, "?action=channel.overwrite_delete", 200), "entries"), "channel.overwrite_delete", pid) == nil {
		t.Fatal("remoção de overwrite sem auditoria")
	}
}

func toAny(js []J) []any {
	out := make([]any, len(js))
	for i, j := range js {
		out[i] = map[string]any(j)
	}
	return out
}

// Um cargo excluído leva seus overwrites; ADMINISTRATOR e dono ignoram overwrites.
func TestOverwritesAdminOwnerAndRoleDelete(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner, admin, member := e.newActor(t, "dono"), e.newActor(t, "adm"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Admin")
	admin.join(t, owner, g.id)
	member.join(t, owner, g.id)
	owner.grantRole(t, g.id, admin, "adm", 4, perm.Administrator)
	r := owner.role(t, g.id, J{"name": "temporario", "position": 2, "permissions": 0})
	owner.giveRole(t, g.id, member.id, str(r, "id"))
	base := "/api/guilds/" + g.id
	ch := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "restrito"}, 201))
	ow := "/api/channels/" + str(ch, "id") + "/overwrites"
	owner.call(t, "PUT", ow+"/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 200)
	owner.call(t, "PUT", ow+"/role/"+str(r, "id"), J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)

	admin.call(t, "GET", "/api/channels/"+str(ch, "id")+"/messages", nil, 200) // administrador passa
	owner.call(t, "GET", "/api/channels/"+str(ch, "id")+"/messages", nil, 200)
	member.call(t, "GET", "/api/channels/"+str(ch, "id")+"/messages", nil, 200)

	owner.call(t, "DELETE", base+"/roles/"+str(r, "id"), nil, 204)
	member.call(t, "GET", "/api/channels/"+str(ch, "id")+"/messages", nil, 403)
	if got := arr(t, owner.call(t, "GET", ow, nil, 200)); len(got) != 1 {
		t.Fatalf("overwrite do cargo excluído deveria ter sumido: %v", got)
	}
}

// ---------- voz: canal privado, mute do servidor e desconexão ----------

func TestVoiceModeration(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.ModLimiter = ratelimit.New(100000, 100000)
	})
	owner, mod, victim, peer, plain := e.newActor(t, "dono"), e.newActor(t, "mod"), e.newActor(t, "vitima"), e.newActor(t, "par"), e.newActor(t, "comum")
	g := owner.createGuild(t, "Voz moderada")
	for _, u := range []*actor{mod, victim, peer, plain} {
		u.join(t, owner, g.id)
	}
	owner.grantRole(t, g.id, mod, "mod-voz", 10, perm.MuteMembers|perm.DisconnectMembers)
	owner.grantRole(t, g.id, peer, "par-voz", 10, perm.MuteMembers|perm.DisconnectMembers)
	base := "/api/guilds/" + g.id

	// Canal de voz privado: o comum não conecta nem enxerga quem está nele.
	priv := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 1, "name": "sala-vip"}, 201))
	pid := str(priv, "id")
	owner.call(t, "PUT", "/api/channels/"+pid+"/overwrites/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 200)
	owner.call(t, "PUT", "/api/channels/"+pid+"/overwrites/member/"+victim.id, J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)
	plain.voiceToken(t, pid, 403)
	victim.voiceToken(t, pid, 200)
	e.lkJoin(t, pid, victim)
	if got := arr(t, plain.call(t, "GET", base+"/voice-states", nil, 200)); len(got) != 0 {
		t.Fatalf("o comum vê quem está no canal privado: %v", got)
	}
	if got := arr(t, victim.call(t, "GET", base+"/voice-states", nil, 200)); len(got) != 1 {
		t.Fatalf("quem está no canal vê: %v", got)
	}
	plainWS := plain.connect(t)
	_, ready := plainWS.identify()
	if vs := list(ready, "voice_states"); len(vs) != 0 {
		t.Fatalf("READY do comum vaza voz do canal privado: %v", vs)
	}
	// Tira o CONNECT do canal: a pessoa é derrubada da sala (reavaliação por overwrites).
	owner.call(t, "PUT", "/api/channels/"+pid+"/overwrites/member/"+victim.id, J{"allow": int64(perm.ViewChannel), "deny": int64(perm.Connect)}, 200)
	waitUntil(t, "vítima removida por perder CONNECT", func() bool { return lkf.hasRemoved(pid + "/" + victim.id) })
	owner.call(t, "DELETE", "/api/channels/"+pid+"/overwrites/member/"+victim.id, nil, 204)

	// Mute do servidor: hierarquia, permissão e persistência (o token já sai sem microfone).
	resp, b := e.do(t, "PUT", base+"/members/"+victim.id+"/voice-mute", nil, nil)
	status(t, resp, b, 401)
	plain.call(t, "PUT", base+"/members/"+victim.id+"/voice-mute", nil, 403)
	mod.call(t, "PUT", base+"/members/"+peer.id+"/voice-mute", nil, 403)  // cargo igual
	mod.call(t, "PUT", base+"/members/"+owner.id+"/voice-mute", nil, 403) // dono
	mod.call(t, "PUT", base+"/members/"+mod.id+"/voice-mute", nil, 422)   // a si mesmo
	mod.call(t, "PUT", base+"/members/987654321/voice-mute", nil, 404)

	victim.voiceToken(t, g.voiceID, 200)
	e.lkJoin(t, g.voiceID, victim)
	ws := plain.connect(t)
	ws.identify()
	m := obj(t, mod.call(t, "PUT", base+"/members/"+victim.id+"/voice-mute", nil, 200))
	if m["voice_muted"] != true {
		t.Fatalf("voice_muted: %v", m)
	}
	st := ws.voiceUpdateFor(victim.id)
	if st["server_muted"] != true {
		t.Fatalf("server_muted no estado de voz: %v", st)
	}
	waitUntil(t, "permissões atualizadas no LiveKit", func() bool {
		lkf.mu.Lock()
		defer lkf.mu.Unlock()
		for _, u := range lkf.updated {
			if u == g.voiceID+"/"+victim.id {
				return true
			}
		}
		return false
	})
	// Reentrar não desfaz o mute: o token vem sem microfone.
	claims, _ := decodeToken(t, victim.voiceToken(t, g.voiceID, 200).Token)
	for _, s := range claims.Video.CanPublishSources {
		if s == "microphone" {
			t.Fatalf("mutado pelo servidor ganhou o microfone: %v", claims.Video.CanPublishSources)
		}
	}
	// Desmutar devolve.
	if m := obj(t, mod.call(t, "DELETE", base+"/members/"+victim.id+"/voice-mute", nil, 200)); m["voice_muted"] == true {
		t.Fatalf("voice_muted: %v", m)
	}
	claims, _ = decodeToken(t, victim.voiceToken(t, g.voiceID, 200).Token)
	hasMic := false
	for _, s := range claims.Video.CanPublishSources {
		hasMic = hasMic || s == "microphone"
	}
	if !hasMic {
		t.Fatal("desmutado deveria voltar a ter microfone")
	}

	// Desconectar: permissão, hierarquia, estado e RemoveParticipant.
	dc := "/api/channels/" + g.voiceID + "/voice/" + victim.id + "/disconnect"
	plain.call(t, "POST", dc, nil, 403)
	mod.call(t, "POST", "/api/channels/"+g.voiceID+"/voice/"+peer.id+"/disconnect", nil, 403)
	mod.call(t, "POST", "/api/channels/"+g.voiceID+"/voice/"+owner.id+"/disconnect", nil, 403)
	mod.call(t, "POST", "/api/channels/"+g.textID+"/voice/"+victim.id+"/disconnect", nil, 422)
	mod.call(t, "POST", "/api/channels/"+g.voiceID+"/voice/"+peer.id+"x/disconnect", nil, 404)
	e.lkJoin(t, g.voiceID, victim)
	mod.call(t, "POST", dc, nil, 204)
	if !lkf.hasRemoved(g.voiceID + "/" + victim.id) {
		t.Fatal("RemoveParticipant não foi chamado")
	}
	mod.call(t, "POST", dc, nil, 409) // já não está na sala

	// Auditoria.
	entries := list(owner.auditLog(t, g.id, "", 200), "entries")
	for _, a := range []audit.Action{audit.VoiceMute, audit.VoiceUnmute, audit.VoiceDisconnect} {
		if hasAudit(entries, string(a), victim.id) == nil {
			t.Errorf("falta %s na auditoria", a)
		}
	}
	_ = lk.Room{}
}

// ---------- auditoria ----------

func TestAuditLogEndpoint(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner, auditor, member := e.newActor(t, "dono"), e.newActor(t, "auditor"), e.newActor(t, "membro")
	g := owner.createGuild(t, "Auditado")
	auditor.join(t, owner, g.id)
	member.join(t, owner, g.id)
	base := "/api/guilds/" + g.id

	// Ações variadas do dono.
	ch := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "novo"}, 201))
	owner.call(t, "PATCH", "/api/channels/"+str(ch, "id"), J{"name": "renomeado"}, 200)
	owner.call(t, "DELETE", "/api/channels/"+str(ch, "id"), nil, 204)
	r := owner.role(t, g.id, J{"name": "cargo-x", "position": 1, "permissions": 0})
	owner.giveRole(t, g.id, member.id, str(r, "id"))
	owner.call(t, "DELETE", base+"/members/"+member.id+"/roles/"+str(r, "id"), nil, 200)
	owner.call(t, "PATCH", base+"/roles/"+str(r, "id"), J{"name": "cargo-y"}, 200)
	owner.call(t, "DELETE", base+"/roles/"+str(r, "id"), nil, 204)
	code := owner.invite(t, g.id)
	owner.call(t, "DELETE", "/api/invites/"+code, nil, 204)
	owner.call(t, "PATCH", base, J{"name": "Auditado 2"}, 200)
	owner.call(t, "DELETE", base+"/members/"+member.id, nil, 204)

	// Sem VIEW_AUDIT_LOG: 403 (dono tem). Não-membro: 404. Sem sessão: 401.
	auditor.auditLog(t, g.id, "", 403)
	e.newActor(t, "estranho").auditLog(t, g.id, "", 404)
	resp, b := e.do(t, "GET", base+"/audit-logs", nil, nil)
	status(t, resp, b, 401)
	owner.grantRole(t, g.id, auditor, "auditoria", 2, perm.ViewAuditLog)

	all := obj(t, auditor.call(t, "GET", base+"/audit-logs?limit=100", nil, 200))
	entries := list(all, "entries")
	for _, a := range []audit.Action{audit.ChannelCreate, audit.ChannelUpdate, audit.ChannelDelete, audit.RoleCreate, audit.RoleUpdate,
		audit.RoleDelete, audit.MemberRoleAdd, audit.MemberRoleRemove, audit.InviteCreate, audit.InviteRevoke, audit.GuildUpdate, audit.MemberKick} {
		if hasAudit(entries, string(a), "") == nil {
			t.Errorf("falta %s: %d entradas", a, len(entries))
		}
	}
	first := entries[0]
	if sub(first, "actor") == nil || str(sub(first, "actor"), "username") == "" || str(first, "created_at") == "" {
		t.Fatalf("entrada sem autor/hora: %v", first)
	}
	if k := hasAudit(entries, "member.kick", member.id); k == nil || sub(k, "changes")["target_name"] == nil {
		t.Fatalf("kick: %v", k)
	}

	// Filtros por ação e autor; ação inválida → 422; paginação por cursor sem repetir nem pular.
	onlyKick := list(obj(t, auditor.call(t, "GET", base+"/audit-logs?action=member.kick", nil, 200)), "entries")
	if len(onlyKick) != 1 {
		t.Fatalf("filtro por ação: %v", onlyKick)
	}
	auditor.call(t, "GET", base+"/audit-logs?action=banana", nil, 422)
	auditor.call(t, "GET", base+"/audit-logs?actor=abc", nil, 422)
	if got := list(obj(t, auditor.call(t, "GET", base+"/audit-logs?actor="+member.id, nil, 200)), "entries"); len(got) != 0 {
		t.Fatalf("filtro por autor: %v", got)
	}
	if got := list(obj(t, auditor.call(t, "GET", base+"/audit-logs?actor="+owner.id+"&limit=100", nil, 200)), "entries"); len(got) != len(entries) {
		t.Fatalf("autor dono: %d vs %d", len(got), len(entries))
	}
	var seen []string
	cursor := ""
	for page := 0; page < 20; page++ {
		q := "?limit=4"
		if cursor != "" {
			q += "&before=" + cursor
		}
		pg := obj(t, auditor.call(t, "GET", base+"/audit-logs"+q, nil, 200))
		es := list(pg, "entries")
		for _, en := range es {
			seen = append(seen, str(en, "id"))
		}
		if pg["has_more"] != true {
			break
		}
		cursor = str(es[len(es)-1], "id")
	}
	if len(seen) != len(entries) {
		t.Fatalf("paginação devolveu %d de %d", len(seen), len(entries))
	}
	uniqIDs := map[string]bool{}
	for _, id := range seen {
		if uniqIDs[id] {
			t.Fatalf("entrada repetida %s", id)
		}
		uniqIDs[id] = true
	}
}

// A retenção apaga em lotes só o que passou do prazo.
func TestAuditRetentionPurge(t *testing.T) {
	e := newEnvWith(t, modCfg)
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Retenção")
	owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "um"}, 201)
	owner.call(t, "POST", "/api/guilds/"+g.id+"/channels", J{"type": 0, "name": "dois"}, 201)
	if _, err := e.pool.Exec(t.Context(), `UPDATE audit_logs SET created_at = now() - interval '100 days' WHERE guild_id = $1 AND id = (SELECT min(id) FROM audit_logs WHERE guild_id = $1)`, g.id); err != nil {
		t.Fatal(err)
	}
	svc := audit.NewService(audit.NewStore(e.pool), nil, nil, nil)
	n, err := svc.Purge(t.Context(), 90*24*time.Hour)
	if err != nil || n < 1 {
		t.Fatalf("purge = %d, %v", n, err)
	}
	if got := list(obj(t, owner.call(t, "GET", "/api/guilds/"+g.id+"/audit-logs", nil, 200)), "entries"); len(got) != 1 {
		t.Fatalf("depois da retenção sobrou: %v", got)
	}
}

// ---------- vazamentos: menções, não lidas, prévia de tela ----------

func TestPrivateChannelDoesNotLeak(t *testing.T) {
	lkf := newFakeLiveKit(t)
	e := newEnvWith(t, func(d *Deps) {
		voiceCfg(lkf)(d)
		d.ModLimiter = ratelimit.New(100000, 100000)
	})
	owner, vip, plain := e.newActor(t, "dono"), e.newActor(t, "vip"), e.newActor(t, "comum")
	g := owner.createGuild(t, "Vazamento")
	vip.join(t, owner, g.id)
	plain.join(t, owner, g.id)
	base := "/api/guilds/" + g.id

	txt := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 0, "name": "reservado"}, 201))
	vc := obj(t, owner.call(t, "POST", base+"/channels", J{"type": 1, "name": "sala-reservada"}, 201))
	for _, c := range []J{txt, vc} {
		ow := "/api/channels/" + str(c, "id") + "/overwrites"
		owner.call(t, "PUT", ow+"/role/"+g.id, J{"allow": 0, "deny": int64(perm.ViewChannel)}, 200)
		owner.call(t, "PUT", ow+"/member/"+vip.id, J{"allow": int64(perm.ViewChannel), "deny": 0}, 200)
	}

	// Menções: só quem vê o canal conta; as não lidas do comum não incluem o canal.
	owner.call(t, "POST", "/api/channels/"+str(txt, "id")+"/messages", J{"content": "oi @" + vip.name + " e @" + plain.name}, 201)
	waitUntil(t, "menção do vip", func() bool {
		for _, rs := range list(obj(t, vip.call(t, "GET", "/api/users/@me/read-states", nil, 200)), "read_states") {
			if str(rs, "channel_id") == str(txt, "id") && num(rs, "mention_count") == 1 {
				return true
			}
		}
		return false
	})
	plainStates := obj(t, plain.call(t, "GET", "/api/users/@me/read-states", nil, 200))
	for _, rs := range list(plainStates, "read_states") {
		if str(rs, "channel_id") == str(txt, "id") {
			t.Fatalf("não lida do canal privado vazou: %v", rs)
		}
	}
	for _, gs := range list(plainStates, "guilds") {
		if num(gs, "mention_count") != 0 || num(gs, "unread_count") != 0 {
			t.Fatalf("o agregado do servidor vazou o canal privado: %v", gs)
		}
	}
	plain.call(t, "PUT", "/api/channels/"+str(txt, "id")+"/ack", J{"message_id": "1"}, 403)

	// Prévia da tela: quem não vê o canal não lê a prévia nem o estado de voz.
	vip.voiceToken(t, str(vc, "id"), 200)
	e.lkJoin(t, str(vc, "id"), vip)
	plain.call(t, "GET", "/api/channels/"+str(vc, "id")+"/voice/screen-preview/"+vip.id, nil, 404)
	plain.voiceToken(t, str(vc, "id"), 403)
	ws := plain.connect(t)
	_, ready := ws.identify()
	if vs := list(ready, "voice_states"); len(vs) != 0 {
		t.Fatalf("voz vazou no READY: %v", vs)
	}
	e.lkEvent(t, "track_published", str(vc, "id"), vip, func(ev *lk.WebhookEvent) {
		ev.Track = &lk.TrackInfo{Source: lk.TrackSource_CAMERA}
	})
	for deadline := time.Now().Add(500 * time.Millisecond); time.Now().Before(deadline); { // nenhum VOICE_STATE_UPDATE do canal privado
		f, err := ws.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, "VOICE_STATE_UPDATE") {
			t.Fatalf("estado de voz do canal privado vazou: %s", f.D)
		}
	}
}

// O limite de ações de moderação devolve 429 com Retry-After.
func TestModerationRateLimit(t *testing.T) {
	e := newEnvWith(t, func(d *Deps) {
		modCfg(d)
		d.ModLimiter = ratelimit.New(0.001, 3)
	})
	owner := e.newActor(t, "dono")
	g := owner.createGuild(t, "Limite")
	base := "/api/guilds/" + g.id
	var targets []*actor
	for i := 0; i < 4; i++ {
		u := e.newActor(t, "alvo")
		u.join(t, owner, g.id)
		targets = append(targets, u)
	}
	for i := 0; i < 3; i++ {
		owner.call(t, "PATCH", base+"/members/"+targets[i].id+"/nick", J{"nick": "n"}, 200)
	}
	resp, b := owner.do(t, "PATCH", base+"/members/"+targets[3].id+"/nick", J{"nick": "n"})
	status(t, resp, b, 429)
	if resp.Header.Get("Retry-After") == "" {
		t.Fatal("429 sem Retry-After")
	}
}
