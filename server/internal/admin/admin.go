// Package admin implementa o painel administrativo (/admin, adicional fora do SPEC): leituras agregadas
// do app (contagens, séries, sistema, chamadas ao vivo) para quem tem users.is_admin.
//
// Segue handler → service → store. Tudo o que não é do banco entra por interfaces definidas aqui, por
// quem consome (chamadas de voz, gateway, pool, métricas do LiveKit) e é ligado em app/admin.go.
// Agregados caros ficam em cache no service (ver cache.go); nenhuma requisição dispara varredura.
package admin

import (
	"context"
	"errors"
	"time"
)

// Parâmetros fixos do painel.
const (
	PageSize   = 25 // linhas por página nas tabelas
	SeriesDays = 14 // dias nos gráficos de barras (UTC, o último é hoje)
	// Janela da comparação "últimos 6 dias completos x 6 anteriores".
	CompareDays = 6
)

// ErrCallsDisabled indica que a voz (LiveKit) não está configurada neste servidor.
var ErrCallsDisabled = errors.New("voz desligada: sem LiveKit configurado")

// ---- portas ----

// Store é o acesso ao banco (implementado em store.go).
type Store interface {
	IsAdmin(ctx context.Context, userID int64) (bool, error)
	Promote(ctx context.Context, usernames []string) ([]string, error)
	Counts(ctx context.Context, now time.Time) (Counts, error)
	MessageTotals(ctx context.Context) (MessageTotals, error)
	UsersPerDay(ctx context.Context, since time.Time) (map[string]int64, error)
	MessagesPerDay(ctx context.Context, since time.Time) (map[string]int64, error)
	DatabaseSize(ctx context.Context) (int64, error)
	LargestTables(ctx context.Context) ([]TableSize, error)
	Users(ctx context.Context, q ListQuery) (UserPage, error)
	Servers(ctx context.Context, q ListQuery) (ServerPage, error)
	Channels(ctx context.Context, ids []int64) (map[int64]ChannelInfo, error)
	Usernames(ctx context.Context, ids []int64) (map[int64]string, error)
	// JobCounts conta os jobs do River por estado; ok=false se a fila não existe (tabela ausente).
	JobCounts(ctx context.Context) (jobs JobCounts, ok bool, err error)
}

// CallSource lista as salas de voz ativas lidas do LiveKit (implementado em app com voice.Service).
// Voz desligada: ErrCallsDisabled.
type CallSource interface {
	LiveRooms(ctx context.Context) ([]LiveRoom, error)
}

// LiveRoom é uma sala ativa (sala = ID do canal).
type LiveRoom struct {
	ChannelID    int64
	Participants []LiveParticipant
	Since        time.Time // zero se desconhecido
}

type LiveParticipant struct {
	UserID int64
	Camera bool
	Screen bool
}

// GatewayStats entrega os números do gateway WebSocket (implementado em app com gateway.Hub).
type GatewayStats interface {
	GatewayStats() GatewaySample
}

// GatewaySample é uma leitura instantânea; EventsTotal é acumulado desde o boot.
type GatewaySample struct {
	Connections, Sessions, Users int
	EventsTotal                  int64
}

// PoolStats entrega o estado do pool do Postgres (implementado em app com pgxpool).
type PoolStats interface {
	PoolStats() PoolSample
}

type PoolSample struct {
	Max, Open, Idle, InUse int32
	WaitCount              int64
}

// MediaMetrics lê o endpoint Prometheus do LiveKit. Erro = indisponível (a mensagem vai para o painel).
type MediaMetrics interface {
	Fetch(ctx context.Context) (MediaSample, error)
}

// MediaSample são os valores lidos do Prometheus do LiveKit; ponteiro nulo = o LiveKit não expôs.
type MediaSample struct {
	Rooms, Participants            float64
	TracksPublished, TracksSubs    float64
	BytesIn, BytesOut              float64 // acumulados desde o boot do LiveKit
	PacketsIn, PacketsOut          float64
	PacketLossPct, JitterMs, RTTMs *float64
	QualityScore                   *float64
}

// ---- modelos de leitura do banco ----

type Counts struct {
	UsersTotal, Admins, UsersNew24h, UsersNew7d, Avatars  int64
	GuildsTotal, GuildIcons, Memberships                  int64
	TextChannels, VoiceChannels, Categories               int64
	DirectChats, GroupChats, Roles                        int64
	InvitesActive, InviteUses                             int64
	Messages24h, Messages7d, Attachments, AttachmentBytes int64
}

type MessageTotals struct{ Total, InGuilds, InDMs int64 }

type TableSize struct {
	Name         string `json:"name"`
	Bytes        int64  `json:"bytes"`
	RowsEstimate int64  `json:"rows_estimate"`
}

type JobCounts struct{ Available, Running, Retryable, Discarded, Scheduled int64 }

type ChannelInfo struct {
	Name      string // vazio em DM
	GuildName string // vazio em DM
	DM        bool
}

// ListQuery é a consulta paginada das tabelas de usuários e servidores.
type ListQuery struct {
	Q          string
	Sort       string
	Desc       bool
	Page       int // base 1
	PageOffset int
	PageSize   int
}

type UserRow struct {
	ID           string     `json:"id" doc:"ID Snowflake (string)"`
	Username     string     `json:"username"`
	Email        string     `json:"email"`
	GuildsMember int64      `json:"guilds_member" doc:"Servidores de que participa"`
	GuildsOwned  int64      `json:"guilds_owned" doc:"Servidores que possui"`
	MessagesSent int64      `json:"messages_sent"`
	LastActiveAt *time.Time `json:"last_active_at,omitempty" doc:"Último login (sessão mais recente); o app não registra outra atividade"`
	CreatedAt    time.Time  `json:"created_at"`
}

type UserPage struct {
	Items []UserRow `json:"items"`
	Total int64     `json:"total"`
}

type ServerRow struct {
	ID            string    `json:"id" doc:"ID Snowflake (string)"`
	Name          string    `json:"name"`
	Owner         string    `json:"owner" doc:"Username do dono"`
	Members       int64     `json:"members"`
	Channels      int64     `json:"channels" doc:"Canais de texto e de voz (sem categorias)"`
	Messages      int64     `json:"messages"`
	InvitesActive int64     `json:"invites_active"`
	CreatedAt     time.Time `json:"created_at"`
}

type ServerPage struct {
	Items []ServerRow `json:"items"`
	Total int64       `json:"total"`
}
