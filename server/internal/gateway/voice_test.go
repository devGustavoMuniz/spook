package gateway

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	voicepkg "github.com/devGustavoMuniz/spook/server/internal/voice"
)

type fakeVoice struct {
	mu     sync.Mutex
	guilds []int64
	dms    []int64
}

func (f *fakeVoice) Snapshot(_ int64, guilds, dms []int64) []voicepkg.StatePayload {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.guilds, f.dms = guilds, dms
	if len(guilds) == 0 {
		return nil
	}
	g, c := "10", "100"
	return []voicepkg.StatePayload{{GuildID: &g, ChannelID: &c, UserID: "9"}}
}

func TestReadyVoiceStatesOnlyForVisibleGuilds(t *testing.T) {
	v := &fakeVoice{}
	r := newRig(t, fastCfg(), WithVoice(v))
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone&^perm.ViewChannel)

	_, ready := r.dial("tok-1").identify()
	var d struct {
		VoiceStates []voicepkg.StatePayload `json:"voice_states"`
	}
	if err := json.Unmarshal(ready.D, &d); err != nil || len(d.VoiceStates) != 1 || d.VoiceStates[0].UserID != "9" {
		t.Fatalf("voice_states = %s", ready.D)
	}
	if len(v.guilds) != 1 || v.guilds[0] != 10 {
		t.Fatalf("snapshot deveria pedir só os servidores visíveis: %v", v.guilds)
	}

	// Sem VIEW_CHANNEL: nenhum servidor visível e o campo continua um array (nunca null).
	_, ready = r.dial("tok-2").identify()
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(ready.D, &raw)
	if string(raw["voice_states"]) != "[]" || len(v.guilds) != 0 {
		t.Fatalf("voice_states = %s (servidores pedidos: %v)", raw["voice_states"], v.guilds)
	}
}

func TestReadyWithoutVoiceHasEmptyArray(t *testing.T) {
	r := newRig(t, fastCfg())
	_, ready := r.dial("tok-1").identify()
	var raw map[string]json.RawMessage
	_ = json.Unmarshal(ready.D, &raw)
	if string(raw["voice_states"]) != "[]" {
		t.Fatalf("voice_states = %s", raw["voice_states"])
	}
}

func TestVoiceStateUpdateRespectsViewChannel(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg, WithVoice(&fakeVoice{}))
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone&^perm.ViewChannel)
	seeing, blind := r.dial("tok-1"), r.dial("tok-2")
	seeing.identify()
	blind.identify()

	g, c := "10", "100"
	r.bus.Publish(events.Event{Type: events.VoiceStateUpdate, GuildID: 10, ChannelID: 100, Topics: []string{guildTopic(10)},
		Data: voicepkg.StatePayload{GuildID: &g, ChannelID: &c, UserID: "9"}})
	seeing.expectEvent("VOICE_STATE_UPDATE")
	blind.expectNone(300 * time.Millisecond)
}

// A lista de espectadores de uma transmissão é só do transmissor: os demais recebem o mesmo evento sem ela
// (viewer_count continua).
func TestVoiceStateViewersOnlyForTheStreamer(t *testing.T) {
	cfg := fastCfg()
	cfg.HeartbeatInterval = 10 * time.Second
	r := newRig(t, cfg, WithVoice(&fakeVoice{}))
	r.dir.channels[10] = []int64{100}
	r.dir.setPerm(10, 1, perm.DefaultEveryone)
	r.dir.setPerm(10, 2, perm.DefaultEveryone)
	owner, other := r.dial("tok-1"), r.dial("tok-2")
	owner.identify()
	other.identify()

	g, c := "10", "100"
	r.bus.Publish(events.Event{Type: events.VoiceStateUpdate, GuildID: 10, ChannelID: 100, Topics: []string{guildTopic(10)},
		Data: voicepkg.StatePayload{GuildID: &g, ChannelID: &c, UserID: "1", SelfScreen: true, ViewerCount: 2, Viewers: []string{"2", "3"}}})
	var got, seen struct {
		ViewerCount int      `json:"viewer_count"`
		Viewers     []string `json:"viewers"`
	}
	if err := json.Unmarshal(owner.expectEvent("VOICE_STATE_UPDATE").D, &got); err != nil || got.ViewerCount != 2 || len(got.Viewers) != 2 {
		t.Fatalf("o transmissor deve ver a lista: %+v (%v)", got, err)
	}
	if err := json.Unmarshal(other.expectEvent("VOICE_STATE_UPDATE").D, &seen); err != nil || seen.ViewerCount != 2 || len(seen.Viewers) != 0 {
		t.Fatalf("os demais veem só a contagem: %+v (%v)", seen, err)
	}
}
