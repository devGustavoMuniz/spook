package mailflow

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/platform/mailer"
	"github.com/devGustavoMuniz/spook/server/internal/platform/secret"
)

func TestTokensAreRandomAndHashed(t *testing.T) {
	a, ha, err := NewToken()
	b, hb, _ := NewToken()
	if err != nil || a == b || bytes.Equal(ha, hb) {
		t.Fatal("tokens devem ser aleatórios")
	}
	if len(a) != 43 || !bytes.Equal(ha, HashToken(a)) || strings.Contains(string(ha), a) {
		t.Fatalf("token/hash: %d", len(a))
	}
}

type fakeState struct {
	sendable bool
	marked   int
}

func (f *fakeState) TokenIsSendable(context.Context, int64) (bool, error) { return f.sendable, nil }
func (f *fakeState) MarkSent(context.Context, int64) error                { f.marked++; return nil }

func TestDeliverIsIdempotentAndSealsToken(t *testing.T) {
	box, _, _ := secret.New("k")
	sealed, _ := box.Seal("TOKEN-SECRETO-1234567890")
	mem := &mailer.Memory{}
	st := &fakeState{sendable: true}
	d := &Deliverer{Sender: mem, Box: box, State: st, PublicURL: "https://spook.test"}
	args := SendArgs{Template: string(mailer.TemplatePasswordReset), To: "a@b.com", TokenID: 7, SealedToken: sealed}
	if strings.Contains(sealed, "TOKEN-SECRETO") {
		t.Fatal("o token deve ir cifrado no job")
	}
	if err := d.Deliver(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	msgs := mem.To("a@b.com")
	if len(msgs) != 1 || !strings.Contains(msgs[0].Text, "https://spook.test/reset-password?token=TOKEN-SECRETO-1234567890") || !strings.Contains(msgs[0].Text, "30 minutos") || st.marked != 1 {
		t.Fatalf("envio: %+v marcado=%d", msgs, st.marked)
	}
	// retentativa depois de um token já usado/enviado/expirado: não envia de novo e não é erro
	st.sendable = false
	if err := d.Deliver(context.Background(), args); err != nil || mem.Count() != 1 {
		t.Fatalf("idempotência: %v n=%d", err, mem.Count())
	}
	// falha de SMTP volta como erro (o River tenta de novo com backoff) e NÃO marca como enviado
	st.sendable, mem.FailNext = true, 1
	if err := d.Deliver(context.Background(), args); err == nil || st.marked != 1 {
		t.Fatalf("falha deveria subir: %v", err)
	}
	// chave do servidor mudou (token ilegível): descarta sem erro
	other, _, _ := secret.New("outra")
	d2 := &Deliverer{Sender: mem, Box: other, State: st, PublicURL: "https://spook.test"}
	if err := d2.Deliver(context.Background(), args); err != nil {
		t.Fatalf("token ilegível: %v", err)
	}
	// o link de verificação aponta para /verify-email
	sealed2, _ := box.Seal("OUTRO-TOKEN-12345678901")
	if err := d.Deliver(context.Background(), SendArgs{Template: string(mailer.TemplateVerify), To: "v@b.com", TokenID: 8, SealedToken: sealed2}); err != nil {
		t.Fatal(err)
	}
	if m := mem.To("v@b.com"); len(m) != 1 || !strings.Contains(m[0].Text, "https://spook.test/verify-email?token=OUTRO-TOKEN-12345678901") {
		t.Fatalf("verify: %+v", m)
	}
}
