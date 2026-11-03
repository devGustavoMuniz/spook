package guild

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"go.opentelemetry.io/otel"

	"github.com/devGustavoMuniz/spook/server/internal/audit"
	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/perm"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/limits"
)

var tracer = otel.Tracer("spook/guild")

// NewGuild reúne tudo que a criação atômica de um servidor precisa.
type NewGuild struct {
	ID, OwnerID                 int64
	Name                        string
	CategoryID, TextID, VoiceID int64
	EveryonePermissions         perm.Perm
	CategoryName, TextName      string
	VoiceName                   string
}

// Store é o que o service precisa do banco.
type Store interface {
	// Create cria servidor, @everyone, categoria, canais e o dono como membro, numa transação.
	// Devolve ErrTooManyGuilds se o dono já está em MaxGuildsPerUser servidores.
	Create(ctx context.Context, n NewGuild) (Guild, error)
	Get(ctx context.Context, id int64) (Guild, error)
	ListByUser(ctx context.Context, userID int64) ([]Guild, error)
	Update(ctx context.Context, id int64, name string, iconKey *string, systemChannelID *int64, systemJoinEnabled bool) (Guild, error)
	Delete(ctx context.Context, id int64) error
	Transfer(ctx context.Context, id, newOwner int64) error

	Access(ctx context.Context, guildID, userID int64) (Access, error) // perm.ErrNotMember
	AccessByUser(ctx context.Context, userID int64) (map[int64]Access, map[int64][]int64, error)
	Members(ctx context.Context, guildID, afterUserID int64, limit int) ([]Member, error)
	Member(ctx context.Context, guildID, userID int64) (Member, error) // ErrMemberNotFound
	RemoveMember(ctx context.Context, guildID, userID int64) error

	// Moderação. Ban grava o banimento e remove o membro (se for) numa transação.
	Ban(ctx context.Context, guildID, userID, by int64, reason *string) (wasMember bool, err error)
	Unban(ctx context.Context, guildID, userID int64) error // ErrBanNotFound
	IsBanned(ctx context.Context, guildID, userID int64) (bool, error)
	Bans(ctx context.Context, guildID, afterUserID int64, limit int) ([]Ban, error)
	UserExists(ctx context.Context, userID int64) (bool, error)
	SetNickname(ctx context.Context, guildID, userID int64, nick *string) error
	SetVoiceMuted(ctx context.Context, guildID, userID int64, muted bool) error
	VoiceMuted(ctx context.Context, guildID, userID int64) (bool, error)

	// SystemChannel é o canal das mensagens de entrada (0 = sem canal de texto) e se estão ligadas.
	SystemChannel(ctx context.Context, guildID int64) (channelID int64, enabled bool, err error)
	IsTextChannel(ctx context.Context, guildID, channelID int64) (bool, error)
	// MembersAccess devolve as permissões base e os cargos de todos os membros (menções em massa).
	MembersAccess(ctx context.Context, guildID int64) ([]perm.Member, error)

	Roles(ctx context.Context, guildID int64) ([]Role, error)
	RolesByGuilds(ctx context.Context, guildIDs []int64) (map[int64][]Role, error)
	Role(ctx context.Context, guildID, roleID int64) (Role, error) // ErrRoleNotFound
	CreateRole(ctx context.Context, r Role) (Role, error)
	UpdateRole(ctx context.Context, r Role) (Role, error)
	DeleteRole(ctx context.Context, guildID, roleID int64) error
	AddMemberRole(ctx context.Context, guildID, userID, roleID int64) error
	RemoveMemberRole(ctx context.Context, guildID, userID, roleID int64) error
}

// Channels é o que guild precisa de channel para montar o servidor completo.
type Channels interface {
	// ListVisible e ListVisibleByGuilds devolvem só os canais que o membro vê (permissão efetiva do canal).
	ListVisible(ctx context.Context, guildID int64, m perm.Member) ([]channel.Channel, error)
	ListVisibleByGuilds(ctx context.Context, members map[int64]perm.Member) (map[int64][]channel.Channel, error)
}

// Auditor grava o registro de auditoria (audit.Service; pode ser nil).
type Auditor interface {
	Record(ctx context.Context, e audit.Entry)
}

// Limiter limita as ações de moderação por usuário (ratelimit.Limiter; pode ser nil).
type Limiter interface {
	Take(key string) (bool, time.Duration)
}

// Storage é o que guild precisa do storage S3 para ícones (pode ser nil: ícones desligados).
type Storage interface {
	PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
}

// Avatars resolve a chave de avatar de um usuário em URL de leitura.
type Avatars interface {
	AvatarURLForKey(ctx context.Context, key *string) string
}

type IDGenerator interface{ Next() int64 }

const (
	MaxIconBytes = 5 << 20
	iconPutTTL   = 5 * time.Minute
	iconGetTTL   = time.Hour
	maxPageSize  = 1000
)

var iconTypes = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp"}

type Service struct {
	store    Store
	channels Channels
	storage  Storage
	avatars  Avatars
	ids      IDGenerator
	pub      events.Publisher
	audit    Auditor
	limit    Limiter
	lim      limits.Limits
}

// SetAudit liga o registro de auditoria; SetLimiter, o rate limit das ações de moderação; SetLimits, os limites
// de domínio configuráveis (LIMIT_*).
func (s *Service) SetAudit(a Auditor)        { s.audit = a }
func (s *Service) SetLimiter(l Limiter)      { s.limit = l }
func (s *Service) SetLimits(l limits.Limits) { s.lim = l.Normalize() }

func (s *Service) record(ctx context.Context, e audit.Entry) {
	if s.audit != nil {
		s.audit.Record(ctx, e)
	}
}

func (s *Service) take(userID int64) error {
	if s.limit == nil {
		return nil
	}
	if ok, wait := s.limit.Take("mod:" + httpx.ID(userID)); !ok {
		return apperr.RateLimited("muitas ações de moderação seguidas; aguarde um pouco", wait)
	}
	return nil
}

func NewService(store Store, channels Channels, storage Storage, avatars Avatars, ids IDGenerator, pub events.Publisher) *Service {
	return &Service{store: store, channels: channels, storage: storage, avatars: avatars, ids: ids, pub: pub, lim: limits.Default()}
}

// ---------- acesso ----------

// Member devolve o membro com as permissões efetivas. Se o usuário não é membro, devolve
// perm.ErrNotMember. É a porta de entrada das checagens de permissão dos demais pacotes.
func (s *Service) Member(ctx context.Context, guildID, userID int64) (perm.Member, error) {
	a, err := s.store.Access(ctx, guildID, userID)
	if err != nil {
		return perm.Member{}, err
	}
	return newMember(guildID, userID, a), nil
}

func newMember(guildID, userID int64, a Access) perm.Member {
	m := perm.NewMember(userID, a.OwnerID == userID, a.Perms, a.Highest)
	m.GuildID, m.RoleIDs = guildID, a.RoleIDs
	return m
}

// member é Member com a tradução para "servidor inexistente" usada pelas operações do próprio pacote.
func (s *Service) member(ctx context.Context, guildID, userID int64) (perm.Member, error) {
	m, err := s.Member(ctx, guildID, userID)
	if errors.Is(err, perm.ErrNotMember) {
		return perm.Member{}, ErrNotFound
	}
	return m, err
}

func (s *Service) require(ctx context.Context, guildID, userID int64, need perm.Perm) (perm.Member, error) {
	m, err := s.member(ctx, guildID, userID)
	if err != nil {
		return perm.Member{}, err
	}
	if !m.Has(need) {
		return perm.Member{}, ErrForbidden
	}
	return m, nil
}

// ---------- servidores ----------

func (s *Service) iconURL(ctx context.Context, g Guild) string {
	if s.storage == nil || g.IconKey == nil {
		return ""
	}
	u, err := s.storage.PresignGet(ctx, *g.IconKey, iconGetTTL)
	if err != nil {
		return ""
	}
	return u
}

// IconURL resolve a chave de ícone de um servidor em URL de leitura ("" se não houver).
func (s *Service) IconURL(ctx context.Context, key *string) string {
	return s.iconURL(ctx, Guild{IconKey: key})
}

func (s *Service) Create(ctx context.Context, userID int64, name string) (Detail, error) {
	ctx, span := tracer.Start(ctx, "guild.Create")
	defer span.End()
	name, ok := httpx.Name(name, 2, 100)
	if !ok {
		return Detail{}, apperr.Invalid("o nome do servidor deve ter de 2 a 100 caracteres")
	}
	g, err := s.store.Create(ctx, NewGuild{
		ID: s.ids.Next(), OwnerID: userID, Name: name,
		CategoryID: s.ids.Next(), TextID: s.ids.Next(), VoiceID: s.ids.Next(),
		EveryonePermissions: perm.DefaultEveryone,
		CategoryName:        "Canais", TextName: "geral", VoiceName: "Geral",
	})
	if err != nil {
		return Detail{}, err
	}
	d, err := s.detail(ctx, g, userID)
	if err != nil {
		return Detail{}, err
	}
	s.publishGuildCreate(d, userID)
	return d, nil
}

func (s *Service) detail(ctx context.Context, g Guild, userID int64) (Detail, error) {
	m, err := s.member(ctx, g.ID, userID)
	if err != nil {
		return Detail{}, err
	}
	roles, err := s.store.Roles(ctx, g.ID)
	if err != nil {
		return Detail{}, err
	}
	chans, err := s.channels.ListVisible(ctx, g.ID, m)
	if err != nil {
		return Detail{}, err
	}
	mem, err := s.store.Member(ctx, g.ID, userID)
	if err != nil {
		return Detail{}, err
	}
	return Detail{Guild: g, IconURL: s.iconURL(ctx, g), Roles: roles, Channels: chans, Member: m, MyRoleIDs: mem.RoleIDs}, nil
}

// PublishJoined avisa que userID entrou no servidor (via convite): o novo membro recebe o
// servidor completo e os demais membros recebem GUILD_MEMBER_ADD. Devolve o servidor completo.
func (s *Service) PublishJoined(ctx context.Context, guildID, userID int64) (Detail, error) {
	g, err := s.store.Get(ctx, guildID)
	if err != nil {
		return Detail{}, err
	}
	d, err := s.detail(ctx, g, userID)
	if err != nil {
		return Detail{}, err
	}
	s.publishGuildCreate(d, userID)
	if mem, err := s.store.Member(ctx, guildID, userID); err == nil {
		mem.AvatarURL, mem.BannerURL = s.avatars.AvatarURLForKey(ctx, mem.AvatarKey), s.avatars.AvatarURLForKey(ctx, mem.BannerKey)
		s.publish(events.GuildMemberAdd, guildID, mem.Payload())
	}
	return d, nil
}

// Get devolve o servidor completo; não-membro recebe ErrNotFound.
func (s *Service) Get(ctx context.Context, userID, guildID int64) (Detail, error) {
	ctx, span := tracer.Start(ctx, "guild.Get")
	defer span.End()
	if _, err := s.member(ctx, guildID, userID); err != nil {
		return Detail{}, err
	}
	g, err := s.store.Get(ctx, guildID)
	if err != nil {
		return Detail{}, err
	}
	return s.detail(ctx, g, userID)
}

// List devolve os servidores do usuário, completos, em lote (sem N+1).
func (s *Service) List(ctx context.Context, userID int64) ([]Detail, error) {
	ctx, span := tracer.Start(ctx, "guild.List")
	defer span.End()
	gs, err := s.store.ListByUser(ctx, userID)
	if err != nil || len(gs) == 0 {
		return []Detail{}, err
	}
	ids := make([]int64, len(gs))
	for i, g := range gs {
		ids[i] = g.ID
	}
	access, myRoles, err := s.store.AccessByUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	roles, err := s.store.RolesByGuilds(ctx, ids)
	if err != nil {
		return nil, err
	}
	members := make(map[int64]perm.Member, len(gs))
	for _, g := range gs {
		members[g.ID] = newMember(g.ID, userID, access[g.ID])
	}
	chans, err := s.channels.ListVisibleByGuilds(ctx, members)
	if err != nil {
		return nil, err
	}
	out := make([]Detail, 0, len(gs))
	for _, g := range gs {
		out = append(out, Detail{
			Guild: g, IconURL: s.iconURL(ctx, g), Roles: roles[g.ID], Member: members[g.ID], MyRoleIDs: myRoles[g.ID],
			Channels: chans[g.ID],
		})
	}
	return out, nil
}

type UpdateParams struct {
	Name    *string
	IconKey *string // nil = não altera; "" = remove o ícone
	// SystemChannelID: nil = não altera; 0 = volta ao padrão (o primeiro canal de texto); senão, um canal de texto do servidor.
	SystemChannelID *int64
	// SystemJoinEnabled liga ou desliga as mensagens de boas-vindas (nil = não altera).
	SystemJoinEnabled *bool
}

func (s *Service) Update(ctx context.Context, userID, guildID int64, in UpdateParams) (Guild, error) {
	ctx, span := tracer.Start(ctx, "guild.Update")
	defer span.End()
	if _, err := s.require(ctx, guildID, userID, perm.ManageGuild); err != nil {
		return Guild{}, err
	}
	cur, err := s.store.Get(ctx, guildID)
	if err != nil {
		return Guild{}, err
	}
	name, icon := cur.Name, cur.IconKey
	if in.Name != nil {
		n, ok := httpx.Name(*in.Name, 2, 100)
		if !ok {
			return Guild{}, apperr.Invalid("o nome do servidor deve ter de 2 a 100 caracteres")
		}
		name = n
	}
	if in.IconKey != nil {
		switch {
		case *in.IconKey == "":
			icon = nil
		case !strings.HasPrefix(*in.IconKey, iconPrefix(guildID)):
			return Guild{}, apperr.Invalid("ícone inválido: use uma chave gerada para este servidor")
		default:
			icon = in.IconKey
		}
	}
	sysChannel, sysEnabled := cur.SystemChannelID, cur.SystemJoinEnabled
	if in.SystemChannelID != nil {
		if *in.SystemChannelID == 0 {
			sysChannel = nil
		} else {
			ok, err := s.store.IsTextChannel(ctx, guildID, *in.SystemChannelID)
			if err != nil {
				return Guild{}, err
			}
			if !ok {
				return Guild{}, apperr.Invalid("o canal de mensagens do sistema precisa ser um canal de texto deste servidor")
			}
			id := *in.SystemChannelID
			sysChannel = &id
		}
	}
	if in.SystemJoinEnabled != nil {
		sysEnabled = *in.SystemJoinEnabled
	}
	g, err := s.store.Update(ctx, guildID, name, icon, sysChannel, sysEnabled)
	if err != nil {
		return Guild{}, err
	}
	s.publish(events.GuildUpdate, guildID, g.Payload(s.iconURL(ctx, g)))
	ch := map[string]any{"target_name": g.Name}
	if g.SystemJoinEnabled != cur.SystemJoinEnabled {
		ch["system_join_enabled"] = map[string]any{"from": cur.SystemJoinEnabled, "to": g.SystemJoinEnabled}
	}
	if !sameID(cur.SystemChannelID, g.SystemChannelID) {
		ch["system_channel_id"] = map[string]any{"from": httpx.IDPtr(cur.SystemChannelID), "to": httpx.IDPtr(g.SystemChannelID)}
	}
	if g.Name != cur.Name {
		ch["name"] = map[string]any{"from": cur.Name, "to": g.Name}
	}
	if (g.IconKey == nil) != (cur.IconKey == nil) || (g.IconKey != nil && cur.IconKey != nil && *g.IconKey != *cur.IconKey) {
		ch["icon_changed"] = true
	}
	if len(ch) > 1 {
		s.record(ctx, audit.Entry{GuildID: guildID, ActorID: userID, Action: audit.GuildUpdate, TargetType: audit.TargetGuild, TargetID: guildID, Changes: ch})
	}
	return g, nil
}

type IconUpload struct{ URL, Key string }

// RequestIconUpload devolve uma URL pré-assinada para enviar o ícone direto ao storage.
func (s *Service) RequestIconUpload(ctx context.Context, userID, guildID int64, contentType string, size int64) (IconUpload, error) {
	if _, err := s.require(ctx, guildID, userID, perm.ManageGuild); err != nil {
		return IconUpload{}, err
	}
	if s.storage == nil {
		return IconUpload{}, fmt.Errorf("storage não configurado")
	}
	ext, ok := iconTypes[contentType]
	if !ok || size <= 0 || size > MaxIconBytes {
		return IconUpload{}, apperr.Invalid("ícone inválido: use png, jpeg ou webp de até 5 MB")
	}
	key := fmt.Sprintf("%s%d.%s", iconPrefix(guildID), s.ids.Next(), ext)
	u, err := s.storage.PresignPut(ctx, key, contentType, size, iconPutTTL)
	if err != nil {
		return IconUpload{}, err
	}
	return IconUpload{URL: u, Key: key}, nil
}

func iconPrefix(guildID int64) string { return fmt.Sprintf("guild-icons/%d/", guildID) }

// Delete exclui o servidor; só o dono.
func (s *Service) Delete(ctx context.Context, userID, guildID int64) error {
	ctx, span := tracer.Start(ctx, "guild.Delete")
	defer span.End()
	m, err := s.member(ctx, guildID, userID)
	if err != nil {
		return err
	}
	if !m.IsOwner {
		return apperr.Forbidden("só o dono pode excluir o servidor")
	}
	g, gerr := s.store.Get(ctx, guildID)
	if err := s.store.Delete(ctx, guildID); err != nil {
		return err
	}
	// O registro de auditoria some junto com o servidor (ON DELETE CASCADE): a exclusão fica só neste log estruturado.
	slog.Info("servidor excluído", "guild_id", guildID, "guild_name", g.Name, "owner_id", userID, "lookup_err", gerr)
	s.publish(events.GuildDelete, guildID, GuildDeletePayload{ID: httpx.ID(guildID)})
	return nil
}

// Transfer passa a posse para outro membro; só o dono.
func (s *Service) Transfer(ctx context.Context, userID, guildID, newOwner int64) (Guild, error) {
	ctx, span := tracer.Start(ctx, "guild.Transfer")
	defer span.End()
	m, err := s.member(ctx, guildID, userID)
	if err != nil {
		return Guild{}, err
	}
	if !m.IsOwner {
		return Guild{}, apperr.Forbidden("só o dono pode transferir a posse")
	}
	if newOwner == userID {
		return Guild{}, apperr.Invalid("você já é o dono do servidor")
	}
	if _, err := s.store.Access(ctx, guildID, newOwner); errors.Is(err, perm.ErrNotMember) {
		return Guild{}, apperr.Invalid("o novo dono precisa ser membro do servidor")
	} else if err != nil {
		return Guild{}, err
	}
	if err := s.store.Transfer(ctx, guildID, newOwner); err != nil {
		return Guild{}, err
	}
	g, err := s.store.Get(ctx, guildID)
	if err != nil {
		return Guild{}, err
	}
	s.publish(events.GuildUpdate, guildID, g.Payload(s.iconURL(ctx, g)))
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: userID, Action: audit.GuildTransferOwner, TargetType: audit.TargetMember, TargetID: newOwner,
		Changes: map[string]any{"target_name": s.memberName(ctx, guildID, newOwner)},
	})
	return g, nil
}

// memberName é o nome legível de um membro para o registro de auditoria (apelido, nome de exibição ou username).
func (s *Service) memberName(ctx context.Context, guildID, userID int64) string {
	m, err := s.store.Member(ctx, guildID, userID)
	if err != nil {
		return ""
	}
	return displayName(m)
}

func displayName(m Member) string {
	switch {
	case m.Nickname != nil && *m.Nickname != "":
		return *m.Nickname
	case m.DisplayName != nil && *m.DisplayName != "":
		return *m.DisplayName
	}
	return m.Username
}

// ---------- membros ----------

// Members lista os membros por ordem de ID, com cursor `after` (ID do último membro visto).
func (s *Service) Members(ctx context.Context, userID, guildID, after int64, limit int) ([]Member, error) {
	ctx, span := tracer.Start(ctx, "guild.Members")
	defer span.End()
	if _, err := s.member(ctx, guildID, userID); err != nil {
		return nil, err
	}
	if limit <= 0 || limit > maxPageSize {
		limit = 100
	}
	ms, err := s.store.Members(ctx, guildID, after, limit)
	if err != nil {
		return nil, err
	}
	s.fillAvatars(ctx, ms)
	return ms, nil
}

func (s *Service) fillAvatars(ctx context.Context, ms []Member) {
	for i := range ms {
		ms[i].AvatarURL, ms[i].BannerURL = s.avatars.AvatarURLForKey(ctx, ms[i].AvatarKey), s.avatars.AvatarURLForKey(ctx, ms[i].BannerKey)
	}
}

// Kick expulsa um membro: KICK_MEMBERS + hierarquia; o dono nunca é expulso.
func (s *Service) Kick(ctx context.Context, actorID, guildID, targetID int64) error {
	ctx, span := tracer.Start(ctx, "guild.Kick")
	defer span.End()
	actor, err := s.member(ctx, guildID, actorID)
	if err != nil {
		return err
	}
	if actorID == targetID {
		return s.Leave(ctx, actorID, guildID)
	}
	if !actor.Has(perm.KickMembers) {
		return ErrForbidden
	}
	target, err := s.Member(ctx, guildID, targetID)
	if errors.Is(err, perm.ErrNotMember) {
		return ErrMemberNotFound
	}
	if err != nil {
		return err
	}
	if !actor.CanKick(target) {
		return apperr.Forbidden("você não pode expulsar este membro")
	}
	if err := s.take(actorID); err != nil {
		return err
	}
	name := s.memberName(ctx, guildID, targetID)
	if err := s.remove(ctx, guildID, targetID); err != nil {
		return err
	}
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: actorID, Action: audit.MemberKick, TargetType: audit.TargetMember, TargetID: targetID,
		Changes: map[string]any{"target_name": name},
	})
	return nil
}

// Leave faz o usuário sair do servidor; o dono precisa transferir a posse antes.
func (s *Service) Leave(ctx context.Context, userID, guildID int64) error {
	ctx, span := tracer.Start(ctx, "guild.Leave")
	defer span.End()
	m, err := s.member(ctx, guildID, userID)
	if err != nil {
		return err
	}
	if m.IsOwner {
		return ErrOwnerCannotLeave
	}
	return s.remove(ctx, guildID, userID)
}

func (s *Service) remove(ctx context.Context, guildID, userID int64) error {
	if err := s.store.RemoveMember(ctx, guildID, userID); err != nil {
		return err
	}
	s.publishRemoved(guildID, userID)
	return nil
}

// publishRemoved avisa a saída de um membro (expulso, banido ou que saiu).
func (s *Service) publishRemoved(guildID, userID int64) {
	s.publish(events.GuildMemberRemove, guildID, MemberRemovePayload{GuildID: httpx.ID(guildID), UserID: httpx.ID(userID)})
	// O ex-membro deixa de ver o servidor: o gateway o desassina dos tópicos do servidor.
	s.pub.Publish(events.Event{
		Type: events.GuildDelete, GuildID: guildID,
		Topics: []string{userTopic(userID)}, Data: GuildDeletePayload{ID: httpx.ID(guildID)},
	})
}

// ---------- cargos ----------

func (s *Service) Roles(ctx context.Context, userID, guildID int64) ([]Role, error) {
	if _, err := s.member(ctx, guildID, userID); err != nil {
		return nil, err
	}
	return s.store.Roles(ctx, guildID)
}

type RoleParams struct {
	Name        *string
	Color       *int32 // nil = não altera (na criação: sem cor); -1 remove a cor na edição
	Position    *int32
	Permissions *perm.Perm
	Mentionable *bool
}

// reservedRoleNames não podem nomear um cargo: confundem com @everyone e @here (menções em massa).
func reservedRoleName(name string) bool {
	switch strings.ToLower(strings.TrimPrefix(strings.TrimSpace(name), "@")) {
	case "everyone", "here":
		return true
	}
	return false
}

func validRole(p RoleParams) error {
	if p.Name != nil {
		n, ok := httpx.Name(*p.Name, 1, 100)
		if !ok {
			return apperr.Invalid("o nome do cargo deve ter de 1 a 100 caracteres")
		}
		if reservedRoleName(n) {
			return apperr.Invalid("os nomes everyone e here são reservados")
		}
	}
	if p.Color != nil && (*p.Color < -1 || *p.Color > 0xFFFFFF) {
		return apperr.Invalid("cor inválida: use um RGB de 0 a 16777215")
	}
	if p.Position != nil && *p.Position < 1 {
		return apperr.Invalid("a posição de um cargo deve ser 1 ou mais (0 é o @everyone)")
	}
	if p.Permissions != nil && !p.Permissions.Valid() {
		return apperr.Invalid("permissões inválidas")
	}
	return nil
}

func (s *Service) CreateRole(ctx context.Context, userID, guildID int64, in RoleParams) (Role, error) {
	ctx, span := tracer.Start(ctx, "guild.CreateRole")
	defer span.End()
	actor, err := s.require(ctx, guildID, userID, perm.ManageRoles)
	if err != nil {
		return Role{}, err
	}
	if in.Name == nil {
		return Role{}, apperr.Invalid("informe o nome do cargo")
	}
	if err := validRole(in); err != nil {
		return Role{}, err
	}
	existing, err := s.store.Roles(ctx, guildID)
	if err != nil {
		return Role{}, err
	}
	if len(existing) >= s.lim.RolesPerGuild {
		return Role{}, TooManyRoles(s.lim.RolesPerGuild)
	}
	r := Role{ID: s.ids.Next(), GuildID: guildID, Position: 1}
	r.Name, _ = httpx.Name(*in.Name, 1, 100)
	if in.Color != nil && *in.Color >= 0 {
		r.Color = in.Color
	}
	if in.Position != nil {
		r.Position = *in.Position
	}
	if in.Permissions != nil {
		r.Permissions = *in.Permissions
	}
	if in.Mentionable != nil {
		r.Mentionable = *in.Mentionable
	}
	if !actor.CanManageRole(int(r.Position), 0, r.Permissions) {
		return Role{}, apperr.Forbidden("você só pode criar cargos abaixo do seu cargo mais alto e só conceder permissões que você tem")
	}
	r, err = s.store.CreateRole(ctx, r)
	if err != nil {
		return Role{}, err
	}
	s.publish(events.RoleCreate, guildID, r.Payload())
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: userID, Action: audit.RoleCreate, TargetType: audit.TargetRole, TargetID: r.ID,
		Changes: map[string]any{"target_name": r.Name, "permissions": int64(r.Permissions), "mentionable": r.Mentionable},
	})
	return r, nil
}

func (s *Service) UpdateRole(ctx context.Context, userID, guildID, roleID int64, in RoleParams) (Role, error) {
	ctx, span := tracer.Start(ctx, "guild.UpdateRole")
	defer span.End()
	actor, err := s.require(ctx, guildID, userID, perm.ManageRoles)
	if err != nil {
		return Role{}, err
	}
	if err := validRole(in); err != nil {
		return Role{}, err
	}
	cur, err := s.store.Role(ctx, guildID, roleID)
	if err != nil {
		return Role{}, err
	}
	next := cur
	if in.Name != nil {
		next.Name, _ = httpx.Name(*in.Name, 1, 100)
	}
	if in.Color != nil {
		if *in.Color < 0 {
			next.Color = nil
		} else {
			next.Color = in.Color
		}
	}
	if in.Position != nil {
		next.Position = *in.Position
	}
	if in.Permissions != nil {
		next.Permissions = *in.Permissions
	}
	if in.Mentionable != nil {
		next.Mentionable = *in.Mentionable
	}
	if cur.IsEveryone() {
		if next.Name != cur.Name || next.Position != cur.Position {
			return Role{}, ErrEveryoneImmutable
		}
		if !actor.CanGrant(cur.Permissions, next.Permissions) {
			return Role{}, apperr.Forbidden("você só pode conceder permissões que você tem")
		}
	} else {
		// Precisa ter hierarquia sobre o cargo atual e sobre a posição de destino.
		if !actor.CanManageRole(int(cur.Position), cur.Permissions, next.Permissions) ||
			!actor.CanManageRole(int(next.Position), cur.Permissions, next.Permissions) {
			return Role{}, apperr.Forbidden("você só pode editar cargos abaixo do seu cargo mais alto e só conceder permissões que você tem")
		}
	}
	r, err := s.store.UpdateRole(ctx, next)
	if err != nil {
		return Role{}, err
	}
	s.publish(events.RoleUpdate, guildID, r.Payload())
	ch := map[string]any{"target_name": r.Name}
	if cur.Name != r.Name {
		ch["name"] = map[string]any{"from": cur.Name, "to": r.Name}
	}
	if cur.Permissions != r.Permissions {
		ch["permissions"] = map[string]any{"from": int64(cur.Permissions), "to": int64(r.Permissions)}
	}
	if cur.Position != r.Position {
		ch["position"] = map[string]any{"from": cur.Position, "to": r.Position}
	}
	if cur.Mentionable != r.Mentionable {
		ch["mentionable"] = map[string]any{"from": cur.Mentionable, "to": r.Mentionable}
	}
	if len(ch) > 1 || !sameColor(cur.Color, r.Color) {
		s.record(ctx, audit.Entry{GuildID: guildID, ActorID: userID, Action: audit.RoleUpdate, TargetType: audit.TargetRole, TargetID: r.ID, Changes: ch})
	}
	return r, nil
}

func (s *Service) DeleteRole(ctx context.Context, userID, guildID, roleID int64) error {
	ctx, span := tracer.Start(ctx, "guild.DeleteRole")
	defer span.End()
	actor, err := s.require(ctx, guildID, userID, perm.ManageRoles)
	if err != nil {
		return err
	}
	cur, err := s.store.Role(ctx, guildID, roleID)
	if err != nil {
		return err
	}
	if cur.IsEveryone() {
		return ErrEveryoneImmutable
	}
	if !actor.CanManageRole(int(cur.Position), cur.Permissions, cur.Permissions) {
		return apperr.Forbidden("você só pode excluir cargos abaixo do seu cargo mais alto")
	}
	if err := s.store.DeleteRole(ctx, guildID, roleID); err != nil {
		return err
	}
	s.publish(events.RoleDelete, guildID, RoleDeletePayload{GuildID: httpx.ID(guildID), RoleID: httpx.ID(roleID)})
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: userID, Action: audit.RoleDelete, TargetType: audit.TargetRole, TargetID: roleID,
		Changes: map[string]any{"target_name": cur.Name},
	})
	return nil
}

// AddMemberRole atribui um cargo a um membro (MANAGE_ROLES + hierarquia).
func (s *Service) AddMemberRole(ctx context.Context, userID, guildID, targetID, roleID int64) (Member, error) {
	return s.changeMemberRole(ctx, userID, guildID, targetID, roleID, true)
}

// RemoveMemberRole retira um cargo de um membro.
func (s *Service) RemoveMemberRole(ctx context.Context, userID, guildID, targetID, roleID int64) (Member, error) {
	return s.changeMemberRole(ctx, userID, guildID, targetID, roleID, false)
}

func (s *Service) changeMemberRole(ctx context.Context, userID, guildID, targetID, roleID int64, add bool) (Member, error) {
	ctx, span := tracer.Start(ctx, "guild.ChangeMemberRole")
	defer span.End()
	actor, err := s.require(ctx, guildID, userID, perm.ManageRoles)
	if err != nil {
		return Member{}, err
	}
	role, err := s.store.Role(ctx, guildID, roleID)
	if err != nil {
		return Member{}, err
	}
	if role.IsEveryone() {
		return Member{}, apperr.Invalid("o cargo @everyone é de todos os membros e não pode ser atribuído nem removido")
	}
	old := role.Permissions
	if add {
		old = 0 // atribuir concede as permissões do cargo
	}
	if !actor.CanManageRole(int(role.Position), old, role.Permissions) {
		return Member{}, apperr.Forbidden("você só pode gerenciar cargos abaixo do seu cargo mais alto e só conceder permissões que você tem")
	}
	if _, err := s.store.Member(ctx, guildID, targetID); err != nil {
		return Member{}, err
	}
	if add {
		err = s.store.AddMemberRole(ctx, guildID, targetID, roleID)
	} else {
		err = s.store.RemoveMemberRole(ctx, guildID, targetID, roleID)
	}
	if err != nil {
		return Member{}, err
	}
	m, err := s.store.Member(ctx, guildID, targetID)
	if err != nil {
		return Member{}, err
	}
	m.AvatarURL, m.BannerURL = s.avatars.AvatarURLForKey(ctx, m.AvatarKey), s.avatars.AvatarURLForKey(ctx, m.BannerKey)
	s.publish(events.GuildMemberUpdate, guildID, m.Payload())
	act := audit.MemberRoleRemove
	if add {
		act = audit.MemberRoleAdd
	}
	s.record(ctx, audit.Entry{
		GuildID: guildID, ActorID: userID, Action: act, TargetType: audit.TargetMember, TargetID: targetID,
		Changes: map[string]any{"target_name": displayName(m), "role_id": httpx.ID(roleID), "role_name": role.Name},
	})
	return m, nil
}

func sameID(a, b *int64) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

func sameColor(a, b *int32) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// ---------- eventos ----------

func userTopic(id int64) string { return "user:" + strconv.FormatInt(id, 10) }

func (s *Service) publish(typ string, guildID int64, data any) {
	s.pub.Publish(events.Event{
		Type: typ, GuildID: guildID, Topics: []string{"guild:" + strconv.FormatInt(guildID, 10)}, Data: data,
	})
}

func (s *Service) publishGuildCreate(d Detail, userID int64) {
	s.pub.Publish(events.Event{
		Type: events.GuildCreate, GuildID: d.Guild.ID, Topics: []string{userTopic(userID)}, Data: d.Payload(),
	})
}

// ChannelView é o que um membro vê de um servidor: se tem VIEW_CHANNEL no servidor (a base, que decide se canais
// novos aparecem para ele) e os canais que vê de fato, já com os overwrites aplicados.
type ChannelView struct {
	Base     bool
	Channels []channel.Channel
}

// ChannelView calcula a visão do usuário (o gateway recalcula as assinaturas com isto). Não-membro:
// perm.ErrNotMember.
func (s *Service) ChannelView(ctx context.Context, guildID, userID int64) (ChannelView, error) {
	m, err := s.Member(ctx, guildID, userID)
	if err != nil {
		return ChannelView{}, err
	}
	chs, err := s.channels.ListVisible(ctx, guildID, m)
	if err != nil {
		return ChannelView{}, err
	}
	return ChannelView{Base: m.Has(perm.ViewChannel), Channels: chs}, nil
}

// IsBanned diz se o usuário está banido do servidor (convites checam antes de entrar).
func (s *Service) IsBanned(ctx context.Context, guildID, userID int64) (bool, error) {
	return s.store.IsBanned(ctx, guildID, userID)
}

// OverwriteTarget resolve o alvo de um overwrite de canal (implementa channel.Access).
func (s *Service) OverwriteTarget(ctx context.Context, guildID int64, t perm.TargetType, id int64) (channel.Target, error) {
	switch t {
	case perm.TargetRole:
		r, err := s.store.Role(ctx, guildID, id)
		if err != nil {
			return channel.Target{}, err
		}
		return channel.Target{Name: r.Name, Rank: int(r.Position), Everyone: r.IsEveryone()}, nil
	case perm.TargetMember:
		a, err := s.store.Access(ctx, guildID, id)
		if errors.Is(err, perm.ErrNotMember) {
			return channel.Target{}, ErrMemberNotFound
		}
		if err != nil {
			return channel.Target{}, err
		}
		return channel.Target{Name: s.memberName(ctx, guildID, id), Rank: a.Highest, IsOwner: a.OwnerID == id}, nil
	}
	return channel.Target{}, apperr.Invalid("tipo de alvo inválido")
}

// VoiceMuted diz se o membro está mutado na voz por um moderador (a voz aplica ao emitir o token).
func (s *Service) VoiceMuted(ctx context.Context, guildID, userID int64) (bool, error) {
	muted, err := s.store.VoiceMuted(ctx, guildID, userID)
	if errors.Is(err, ErrMemberNotFound) {
		return false, nil
	}
	return muted, err
}

// SystemChannel devolve o canal das mensagens de entrada e se estão ligadas (implementa message.SystemChannels).
// Canal 0: o servidor não tem canal de texto.
func (s *Service) SystemChannel(ctx context.Context, guildID int64) (int64, bool, error) {
	return s.store.SystemChannel(ctx, guildID)
}

// MembersAccess devolve os membros com as permissões base e os cargos (implementa channel.Access).
func (s *Service) MembersAccess(ctx context.Context, guildID int64) ([]perm.Member, error) {
	return s.store.MembersAccess(ctx, guildID)
}
