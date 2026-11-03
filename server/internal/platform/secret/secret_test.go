package secret

import "testing"

func TestSignVerify(t *testing.T) {
	b, eph, err := New("chave-mestra")
	if err != nil || eph {
		t.Fatal(err, eph)
	}
	s := b.Sign([]byte(`{"a":1}`))
	got, err := b.Verify(s)
	if err != nil || string(got) != `{"a":1}` {
		t.Fatalf("verify: %v %q", err, got)
	}
	// adulterado
	if _, err := b.Verify("x" + s); err == nil {
		t.Fatal("payload adulterado deveria falhar")
	}
	// outra chave
	o, _, _ := New("outra")
	if _, err := o.Verify(s); err == nil {
		t.Fatal("outra chave deveria falhar")
	}
	if _, err := b.Verify("sem-ponto"); err == nil {
		t.Fatal("sem assinatura deveria falhar")
	}
}

func TestSealOpen(t *testing.T) {
	b, _, _ := New("k")
	s, err := b.Seal("token-secreto")
	if err != nil || s == "token-secreto" {
		t.Fatal(err, s)
	}
	if got, err := b.Open(s); err != nil || got != "token-secreto" {
		t.Fatalf("open: %v %q", err, got)
	}
	if _, err := b.Open(s[:len(s)-2] + "AA"); err == nil {
		t.Fatal("adulterado deveria falhar")
	}
	o, _, _ := New("outra")
	if _, err := o.Open(s); err == nil {
		t.Fatal("outra chave deveria falhar")
	}
}

func TestEphemeralKey(t *testing.T) {
	b, eph, err := New("")
	if err != nil || !eph {
		t.Fatal("chave vazia deve ser efêmera", err)
	}
	if _, err := b.Seal("x"); err != nil {
		t.Fatal(err)
	}
}
