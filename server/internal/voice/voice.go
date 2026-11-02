// Package voice cuida de voz, vídeo e tela (RF09) sobre o LiveKit, em arquitetura hexagonal:
//
//   - domínio (este arquivo): estado de voz, origens de mídia, grants e regras de sala/identidade;
//   - portas (ports.go): Provider (o LiveKit), StateStore (estado em memória), Access (canais e
//     permissões) e Users, todas definidas aqui, por quem consome;
//   - aplicação (service.go e demais): os casos de uso;
//   - adaptadores: voice/livekit (SDK/protocol), voice/memory (estado) e, no pacote app, os de
//     permissão que ligam guild, dm e perm sem que voice importe o store de outra feature.
//
// Sala do LiveKit = ID do canal; identidade do participante = ID do usuário (SPEC 5.4 e 7.7).
package voice

import (
	"strconv"
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

const (
	// TokenTTL é a validade do token do LiveKit (RNF04, SPEC 7.7).
	TokenTTL = 10 * time.Minute
	// PendingTTL é por quanto tempo uma emissão de token vale como "intenção" de entrar num canal,
	// para resolver a corrida entre a emissão e o webhook participant_joined.
	PendingTTL = 30 * time.Second
)

// Tipos de canal que aceitam voz (mesmos números de channel.Type, sem importar o pacote).
const (
	ChannelTypeVoice   = 1
	ChannelTypeDM      = 3
	ChannelTypeGroupDM = 4
)

var (
	ErrDisabled        = apperr.Unavailable("voz indisponível: o LiveKit não está configurado neste servidor")
	ErrNotInVoice      = apperr.Conflict("você não está em um canal de voz")
	ErrNotVoiceChannel = apperr.Invalid("este canal não aceita voz: use um canal de voz ou uma DM")
)

// Source é a origem de uma mídia publicada (TrackSource do LiveKit).
type Source string

const (
	SourceMicrophone       Source = "microphone"
	SourceCamera           Source = "camera"
	SourceScreenShare      Source = "screen_share"
	SourceScreenShareAudio Source = "screen_share_audio"
)

// Grants é o que o participante pode fazer na sala. Subscribe vale sempre; Publish lista as
// origens permitidas (vazio = não publica nada).
type Grants struct {
	Publish []Source
}

// CanPublish diz se o participante pode publicar alguma origem.
func (g Grants) CanPublish() bool { return len(g.Publish) > 0 }

// Has diz se a origem está liberada.
func (g Grants) Has(s Source) bool {
	for _, p := range g.Publish {
		if p == s {
			return true
		}
	}
	return false
}

// GrantsFor traduz as permissões do usuário no canal: SPEAK libera o microfone; VIDEO, câmera e
// tela (com o áudio dela). Em DM todos têm as quatro origens.
func GrantsFor(canSpeak, canVideo bool) Grants {
	var g Grants
	if canSpeak {
		g.Publish = append(g.Publish, SourceMicrophone)
	}
	if canVideo {
		g.Publish = append(g.Publish, SourceCamera, SourceScreenShare, SourceScreenShareAudio)
	}
	return g
}

// ChannelAccess é o que a voz precisa saber do acesso de um usuário a um canal.
type ChannelAccess struct {
	Type       int   // channel.Type: 1 voz, 3 DM, 4 DM em grupo; outros não aceitam voz
	GuildID    int64 // 0 em DM
	CanConnect bool
	CanSpeak   bool
	CanVideo   bool
}

// Voiceable diz se o tipo do canal aceita voz.
func (a ChannelAccess) Voiceable() bool {
	return a.Type == ChannelTypeVoice || a.Type == ChannelTypeDM || a.Type == ChannelTypeGroupDM
}

// Kind é o rótulo do tipo de canal nas métricas.
func (a ChannelAccess) Kind() string {
	if a.GuildID == 0 {
		return "dm"
	}
	return "guild"
}

// State é o estado de voz de um usuário (só em memória, SPEC 6).
type State struct {
	UserID    int64
	ChannelID int64
	GuildID   int64  // 0 em DM
	SID       string // SID do participante no LiveKit (separa a conexão nova da antiga)
	SelfMute  bool
	SelfDeaf  bool
	Video     bool
	Screen    bool
	Preview   bool // há prévia da tela guardada (PreviewStore)
	CanSpeak  bool // últimas permissões aplicadas no LiveKit
	CanVideo  bool
	JoinedAt  time.Time
}

// Payload converte o estado no evento/snapshot.
func (s State) Payload() StatePayload {
	ch := httpx.ID(s.ChannelID)
	p := StatePayload{
		ChannelID: &ch, UserID: httpx.ID(s.UserID),
		SelfMute: s.SelfMute, SelfDeaf: s.SelfDeaf, SelfVideo: s.Video, SelfScreen: s.Screen,
		ScreenPreview: s.Preview,
	}
	if s.GuildID != 0 {
		g := httpx.ID(s.GuildID)
		p.GuildID = &g
	}
	return p
}

// StatePayload é o dado do VOICE_STATE_UPDATE e dos snapshots. channel_id nulo = saiu da voz.
type StatePayload struct {
	GuildID       *string `json:"guild_id" doc:"Nulo em DM"`
	ChannelID     *string `json:"channel_id" doc:"Nulo quando o usuário saiu da voz"`
	UserID        string  `json:"user_id"`
	SelfMute      bool    `json:"self_mute"`
	SelfDeaf      bool    `json:"self_deaf"`
	SelfVideo     bool    `json:"self_video" doc:"Câmera ligada"`
	SelfScreen    bool    `json:"self_screen" doc:"Compartilhando a tela"`
	ScreenPreview bool    `json:"screen_preview" doc:"Há uma prévia (miniatura) da tela disponível em GET /api/channels/{channel_id}/voice/screen-preview/{user_id}"`
}

// leftPayload é o evento de saída do estado s.
func leftPayload(s State) StatePayload {
	p := s.Payload()
	p.ChannelID = nil
	p.SelfVideo, p.SelfScreen, p.ScreenPreview = false, false, false
	return p
}

// Pending é a intenção de entrar num canal, criada na emissão do token.
type Pending struct {
	UserID    int64
	ChannelID int64
	GuildID   int64
	SelfMute  bool
	SelfDeaf  bool
	ExpiresAt time.Time
}

// TokenResponse é o que o cliente usa para conectar ao LiveKit.
type TokenResponse struct {
	URL       string `json:"url" doc:"URL de sinalização do LiveKit (wss://…)"`
	Token     string `json:"token" doc:"JWT do LiveKit, de uma sala só"`
	ExpiresIn int    `json:"expires_in" doc:"Segundos até o token expirar (600)"`
}

// parseRoom e identity convertem sala/identidade do LiveKit em IDs.
func roomName(channelID int64) string { return strconv.FormatInt(channelID, 10) }
func identity(userID int64) string    { return strconv.FormatInt(userID, 10) }
func parseID(s string) (int64, bool)  { return httpx.ParseID(s) }
