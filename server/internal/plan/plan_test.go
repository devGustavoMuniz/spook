package plan

import (
	"bytes"
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"testing"
	"time"
)

var update = flag.Bool("update", false, "regrava packages/shared/fixtures/plans.json")

const fixturePath = "../../../packages/shared/fixtures/plans.json"

func TestMatrix(t *testing.T) {
	cases := []struct {
		tier Tier
		want Limits
	}{
		{Free, Limits{720, 30, false, false}},
		{Nitro, Limits{1080, 60, true, true}},
		{NitroPlus, Limits{1440, 60, true, true}},
		{Tier("lixo"), Limits{720, 30, false, false}}, // desconhecido vale como grátis
		{Tier(""), Limits{720, 30, false, false}},
	}
	for _, c := range cases {
		if got := For(c.tier); got != c.want {
			t.Errorf("For(%q) = %+v, esperado %+v", c.tier, got, c.want)
		}
	}
}

func TestOrderAndHigher(t *testing.T) {
	if Free.Rank() >= Nitro.Rank() || Nitro.Rank() >= NitroPlus.Rank() {
		t.Fatal("a ordem deve ser free < nitro < nitro_plus")
	}
	if Higher(Free, Nitro) != Nitro || Higher(Nitro, Free) != Nitro || Higher(NitroPlus, Nitro) != NitroPlus || Higher(Nitro, NitroPlus) != NitroPlus || Higher(Free, Free) != Free {
		t.Fatal("Higher errado")
	}
	if !NitroPlus.AtLeast(Nitro) || Nitro.AtLeast(NitroPlus) || !Free.AtLeast(Free) {
		t.Fatal("AtLeast errado")
	}
	if _, ok := Parse("nitro_plus"); !ok {
		t.Fatal("nitro_plus deve ser válido")
	}
	if _, ok := Parse("premium"); ok {
		t.Fatal("premium não existe")
	}
	if Free.Paid() || !Nitro.Paid() || !NitroPlus.Paid() {
		t.Fatal("Paid errado")
	}
}

func TestEffective(t *testing.T) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	past, soon, later := now.Add(-time.Hour), now.Add(time.Hour), now.Add(48*time.Hour)
	cases := []struct {
		name string
		es   []Entitlement
		want Tier
	}{
		{"sem concessões", nil, Free},
		{"permanente", []Entitlement{{Tier: Nitro}}, Nitro},
		{"vencida", []Entitlement{{Tier: Nitro, ExpiresAt: &past}}, Free},
		{"vence exatamente agora já não vale", []Entitlement{{Tier: Nitro, ExpiresAt: &now}}, Free},
		{"revogada", []Entitlement{{Tier: NitroPlus, RevokedAt: &past}}, Free},
		{"maior vence", []Entitlement{{Tier: Nitro}, {Tier: NitroPlus, ExpiresAt: &soon}}, NitroPlus},
		{"maior vencida cai para o menor", []Entitlement{{Tier: Nitro, ExpiresAt: &later}, {Tier: NitroPlus, ExpiresAt: &past}}, Nitro},
		{"maior revogada cai para o menor", []Entitlement{{Tier: Nitro}, {Tier: NitroPlus, RevokedAt: &past}}, Nitro},
		{"plano grátis numa linha é ignorado", []Entitlement{{Tier: Free}}, Free},
	}
	for _, c := range cases {
		if got := Effective(c.es, now); got != c.want {
			t.Errorf("%s: Effective = %q, esperado %q", c.name, got, c.want)
		}
	}
}

func TestCurrentPicksLongestOfHighestTier(t *testing.T) {
	now := time.Date(2026, 11, 9, 12, 0, 0, 0, time.UTC)
	a, b := now.Add(time.Hour), now.Add(72*time.Hour)
	got, ok := Current([]Entitlement{
		{Tier: Nitro, Source: "admin", ExpiresAt: &a}, {Tier: Nitro, Source: "code", ExpiresAt: &b}, {Tier: NitroPlus, Source: "admin", ExpiresAt: &a},
	}, now)
	if !ok || got.Tier != NitroPlus || got.Source != "admin" {
		t.Fatalf("Current = %+v %v", got, ok)
	}
	got, _ = Current([]Entitlement{{Tier: Nitro, Source: "code", ExpiresAt: &b}, {Tier: Nitro, Source: "admin"}, {Tier: Nitro, Source: "x", ExpiresAt: &a}}, now)
	if got.Source != "admin" {
		t.Fatalf("a permanente deve ganhar do mesmo plano: %+v", got)
	}
	got, _ = Current([]Entitlement{{Tier: Nitro, Source: "x", ExpiresAt: &a}, {Tier: Nitro, Source: "code", ExpiresAt: &b}}, now)
	if got.Source != "code" {
		t.Fatalf("a que vence mais tarde deve ganhar: %+v", got)
	}
	if _, ok := Current(nil, now); ok {
		t.Fatal("sem concessões não há Current")
	}
}

// A fixture é o contrato com o cliente (apps/web/src/features/nitro/plans.ts é comparado com ela). Rode com
// -update depois de mudar a matriz.
func TestFixtureMatchesMatrix(t *testing.T) {
	want, err := json.MarshalIndent(Table(), "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	path := filepath.FromSlash(fixturePath)
	if *update {
		if err := os.WriteFile(path, want, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("fixture ausente (rode go test ./internal/plan -update): %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("packages/shared/fixtures/plans.json desatualizada: rode `go test ./internal/plan -update`")
	}
}
