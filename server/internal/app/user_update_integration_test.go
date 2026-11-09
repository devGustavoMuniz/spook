//go:build integration

package app

import (
	"testing"
	"time"
)

// userEvent lê até chegar o evento name cujo payload tem id == userID.
func (c *wsClient) userEvent(name, userID string) J {
	c.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		f, err := c.read(time.Until(deadline))
		if err != nil {
			break
		}
		if isEvent(f, name) {
			if p := payload(c.t, f); str(p, "id") == userID {
				return p
			}
		}
	}
	c.t.Fatalf("%s de %s não chegou", name, userID)
	return nil
}

// Quem divide servidor ou DM com o usuário (e as outras sessões dele) recebe USER_UPDATE ao editar o perfil;
// um estranho não recebe.
func TestUserUpdateReachesGuildMatesDMPeersAndOwnSessions(t *testing.T) {
	e := newEnvWith(t, p4Cfg)
	a, mate, peer, stranger := e.newActor(t, "a"), e.newActor(t, "mate"), e.newActor(t, "peer"), e.newActor(t, "estranho")
	friends(t, "Perfil", a, mate)
	// peer divide com A outro servidor e uma DM (a DM só abre com servidor em comum ou amizade).
	friends(t, "Outro Perfil", peer, a)
	a.openDM(t, peer.id, 201)
	stranger.createGuild(t, "Outro")

	mc, _ := mate.connectReady(t)
	pc, _ := peer.connectReady(t)
	sc, _ := stranger.connectReady(t)
	other, _ := a.connectReady(t) // segunda sessão de A

	a.call(t, "PATCH", "/api/users/me", J{"display_name": "Nome Novo", "bio": "olá"}, 200)

	for _, c := range []*wsClient{mc, pc, other} {
		p := c.userEvent("USER_UPDATE", a.id)
		if str(p, "display_name") != "Nome Novo" || str(p, "bio") != "olá" {
			t.Fatalf("payload inesperado: %v", p)
		}
		if _, leaked := p["email"]; leaked {
			t.Fatalf("USER_UPDATE não pode expor e-mail: %v", p)
		}
	}
	sc.noEvent(300*time.Millisecond, "USER_UPDATE")
}
