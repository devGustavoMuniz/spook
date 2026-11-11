package voice_test

import (
	"context"
	"errors"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/voice"
	"github.com/devGustavoMuniz/spook/server/internal/voice/memory"
)

type fixedTiers map[int64]plan.Tier

func (f fixedTiers) Tier(_ context.Context, id int64) (plan.Tier, error) { return f[id], nil }

type failingTiers struct{}

func (failingTiers) Tier(context.Context, int64) (plan.Tier, error) {
	return plan.Free, errors.New("banco fora")
}

func envWithPlans(t *testing.T, p voice.Plans) *env {
	t.Helper()
	e := newEnv(t)
	e.svc = voice.NewService(voice.Deps{Provider: e.prov, Store: memory.New(), Previews: e.pv, Access: e.acc, Users: fakeUsers{}, Pub: e.pub, Plans: p, EnforceScreen: true, Now: e.clk.now})
	return e
}

func TestTokenCarriesPlanLimits(t *testing.T) {
	e := envWithPlans(t, fixedTiers{alice: plan.NitroPlus, bob: plan.Free})
	a := e.token(t, alice, voiceA)
	if a.Plan != "nitro_plus" || a.Limits != plan.For(plan.NitroPlus) {
		t.Fatalf("Nitro+ = %+v", a)
	}
	b := e.token(t, bob, voiceA)
	if b.Plan != "free" || b.Limits.ScreenMaxHeight != 720 || b.Limits.ScreenMaxFPS != 30 {
		t.Fatalf("grátis = %+v", b)
	}
	// Sem planos ligados ou com falha ao ler, o token sai como grátis (a voz nunca cai por causa do plano).
	for _, p := range []voice.Plans{nil, failingTiers{}} {
		r := envWithPlans(t, p).token(t, alice, voiceA)
		if r.Plan != "free" || r.Limits != plan.For(plan.Free) {
			t.Fatalf("fallback = %+v", r)
		}
	}
}

func (e *env) publishScreen(t *testing.T, user, ch int64, sid string, w, h int) {
	t.Helper()
	if err := e.webhook(t, voice.RoomEvent{
		Type: voice.EventTrackPublished, Room: itoa(ch), Identity: itoa(user), Source: voice.SourceScreenShare,
		TrackSID: sid, TrackWidth: w, TrackHeight: h,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestScreenAbovePlanLimitIsMutedButCallSurvives(t *testing.T) {
	e := envWithPlans(t, fixedTiers{alice: plan.Free, bob: plan.Nitro})
	for _, u := range []int64{alice, bob} {
		e.token(t, u, voiceA)
		e.join(t, u, voiceA, "PA_"+itoa(u))
	}

	// Grátis em 1080p passa do limite de 720p: a faixa é silenciada, mas ninguém sai da chamada.
	e.publishScreen(t, alice, voiceA, "TR_A", 1920, 1080)
	if len(e.prov.muted) != 1 || e.prov.muted[0] != [3]string{"301", "11", "TR_A"} {
		t.Fatalf("faixa excedente deveria ser silenciada: %v", e.prov.muted)
	}
	if len(e.prov.removed) != 0 {
		t.Fatalf("nunca derrubar a chamada: %v", e.prov.removed)
	}
	if e.svc.Occupants(voiceA) != 2 {
		t.Fatal("os dois continuam na chamada")
	}

	// Dentro do limite (inclusive a folga de 10%): nada.
	e.publishScreen(t, alice, voiceA, "TR_B", 1280, 720)
	e.publishScreen(t, alice, voiceA, "TR_C", 1366, 768)
	// Nitro: 1080p livre; Nitro+ não existe aqui. Nitro em 1440p passa do limite de 1080p.
	e.publishScreen(t, bob, voiceA, "TR_D", 1920, 1080)
	if len(e.prov.muted) != 1 {
		t.Fatalf("só a primeira deveria ter sido silenciada: %v", e.prov.muted)
	}
	e.publishScreen(t, bob, voiceA, "TR_E", 2560, 1440)
	if len(e.prov.muted) != 2 || e.prov.muted[1][2] != "TR_E" {
		t.Fatalf("Nitro em 1440p: %v", e.prov.muted)
	}
}

func TestScreenEnforcementIsBestEffort(t *testing.T) {
	// Altura desconhecida (webhook sem dimensões): nada é feito.
	e := envWithPlans(t, fixedTiers{alice: plan.Free})
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_1")
	e.publishScreen(t, alice, voiceA, "TR_A", 0, 0)
	if len(e.prov.muted) != 0 {
		t.Fatalf("sem dimensões não há como conferir: %v", e.prov.muted)
	}
	// Falha ao silenciar no LiveKit não devolve erro ao webhook (senão o LiveKit reenvia) e a chamada continua.
	e.prov.muteErr = errors.New("livekit fora")
	e.publishScreen(t, alice, voiceA, "TR_B", 1920, 1080)
	if e.svc.Occupants(voiceA) != 1 {
		t.Fatal("a chamada deve continuar")
	}
	// Falha ao ler o plano também não é erro e não silencia ninguém.
	e2 := envWithPlans(t, failingTiers{})
	e2.token(t, alice, voiceA)
	e2.join(t, alice, voiceA, "PA_1")
	e2.publishScreen(t, alice, voiceA, "TR_A", 3840, 2160)
	if len(e2.prov.muted) != 0 {
		t.Fatal("sem conseguir ler o plano, nada é imposto")
	}
	// Sem planos ligados (Deps.Plans nulo): sem imposição.
	e3 := envWithPlans(t, nil)
	e3.token(t, alice, voiceA)
	e3.join(t, alice, voiceA, "PA_1")
	e3.publishScreen(t, alice, voiceA, "TR_A", 3840, 2160)
	if len(e3.prov.muted) != 0 {
		t.Fatal("sem PlanSource, nada é imposto")
	}
}

// Sem NITRO_ENFORCE_SCREEN (padrão), a tela acima do plano NÃO é silenciada: clientes antigos não conhecem os
// limites e a faixa silenciada deixa quem assiste carregando para sempre.
func TestScreenAbovePlanIsNotMutedWithoutEnforcement(t *testing.T) {
	e := newEnv(t)
	e.svc = voice.NewService(voice.Deps{Provider: e.prov, Store: memory.New(), Previews: e.pv, Access: e.acc, Users: fakeUsers{}, Pub: e.pub, Plans: fixedTiers{alice: plan.Free}, Now: e.clk.now})
	e.token(t, alice, voiceA)
	e.join(t, alice, voiceA, "PA_"+itoa(alice))
	e.publishScreen(t, alice, voiceA, "TR_A", 1920, 1080)
	if len(e.prov.muted) != 0 {
		t.Fatalf("faixa silenciada com a imposição desligada: %v", e.prov.muted)
	}
}
