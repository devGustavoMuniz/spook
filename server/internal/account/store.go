package account

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// EnqueueFunc enfileira, dentro da transação da exclusão, a remoção dos arquivos do S3.
type EnqueueFunc func(ctx context.Context, tx pgx.Tx, keys []string) error

type PGStore struct{ d db.DB }

func NewStore(d db.DB) *PGStore { return &PGStore{d: d} }

var errAlreadyDeleted = errors.New("conta já excluída")

// Delete exclui a conta numa transação só: ou tudo, ou nada.
func (s *PGStore) Delete(ctx context.Context, userID int64, enqueue EnqueueFunc) (res Result, err error) {
	tx, err := s.d.Begin(ctx)
	if err != nil {
		return Result{}, fmt.Errorf("iniciar exclusão de conta: %w", err)
	}
	defer func() { _ = tx.Rollback(ctx) }()
	q := dbgen.New(tx)

	u, err := q.LockUserForDelete(ctx, userID)
	if errors.Is(err, pgx.ErrNoRows) || (err == nil && u.DeletedAt.Valid) {
		return Result{}, errAlreadyDeleted
	}
	if err != nil {
		return Result{}, fmt.Errorf("travar usuário: %w", err)
	}

	owned, err := q.ListOwnedGuilds(ctx, userID)
	if err != nil {
		return Result{}, fmt.Errorf("listar servidores próprios: %w", err)
	}
	if len(owned) > 0 {
		refs := make([]GuildRef, len(owned))
		for i, g := range owned {
			refs[i] = GuildRef{ID: g.ID, Name: g.Name}
		}
		return Result{}, &OwnsGuildsError{Guilds: refs}
	}

	if res.GuildIDs, err = q.ListMemberGuildIDs(ctx, userID); err != nil {
		return Result{}, fmt.Errorf("listar servidores: %w", err)
	}

	// DMs em grupo: o dono passa o bastão ao participante mais antigo (menor ID); sem mais ninguém, o canal some.
	groups, err := q.ListGroupDMsByUser(ctx, userID)
	if err != nil {
		return Result{}, fmt.Errorf("listar DMs em grupo: %w", err)
	}
	for _, g := range groups {
		others, err := q.ListOtherRecipients(ctx, dbgen.ListOtherRecipientsParams{ChannelID: g.ID, UserID: userID})
		if err != nil {
			return Result{}, fmt.Errorf("listar participantes: %w", err)
		}
		if len(others) == 0 {
			if err := q.DeleteChannelByID(ctx, g.ID); err != nil {
				return Result{}, fmt.Errorf("apagar DM em grupo vazia: %w", err)
			}
			continue
		}
		if g.OwnerID != nil && *g.OwnerID == userID {
			if err := q.SetChannelOwner(ctx, dbgen.SetChannelOwnerParams{ID: g.ID, OwnerID: &others[0]}); err != nil {
				return Result{}, fmt.Errorf("passar o dono da DM em grupo: %w", err)
			}
		}
		if err := q.DeleteRecipientRow(ctx, dbgen.DeleteRecipientRowParams{ChannelID: g.ID, UserID: userID}); err != nil {
			return Result{}, fmt.Errorf("sair da DM em grupo: %w", err)
		}
		res.GroupChannels = append(res.GroupChannels, g.ID)
	}

	for name, run := range map[string]func() error{
		"membros":                func() error { return q.DeleteMembershipsByUser(ctx, userID) },
		"sessões":                func() error { return q.DeleteSessionsByUser(ctx, userID) },
		"inscrições de push":     func() error { return q.DeletePushSubscriptionsByUser(ctx, userID) },
		"configurações de aviso": func() error { return q.DeleteNotificationSettingsByUser(ctx, userID) },
		"estados de leitura":     func() error { return q.DeleteReadStatesByUser(ctx, userID) },
	} {
		if err := run(); err != nil {
			return Result{}, fmt.Errorf("apagar %s: %w", name, err)
		}
	}

	res.AnonymizedName = removedUsername(userID)
	if err := q.AnonymizeUser(ctx, dbgen.AnonymizeUserParams{ID: userID, Email: removedEmail(userID), Username: res.AnonymizedName}); err != nil {
		return Result{}, fmt.Errorf("anonimizar usuário: %w", err)
	}

	for _, k := range []*string{u.AvatarKey, u.BannerKey} {
		if k != nil {
			res.FileKeys = append(res.FileKeys, *k)
		}
	}
	if enqueue != nil && len(res.FileKeys) > 0 {
		if err := enqueue(ctx, tx, res.FileKeys); err != nil {
			return Result{}, err
		}
	}
	if err := tx.Commit(ctx); err != nil {
		return Result{}, fmt.Errorf("confirmar exclusão de conta: %w", err)
	}
	return res, nil
}
