package mailflow

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
	"github.com/devGustavoMuniz/spook/server/internal/platform/snowflake"
)

// ResetPasswordUsage é o uso de `spook admin reset-password`.
const ResetPasswordUsage = "uso: spook admin reset-password <username>"

// RunResetPassword gera um link de redefinição de uso único (30 min) e o imprime em out, para o administrador
// repassar à pessoa (alternativa sem SMTP). Roda no container pelo SSH (deploy/admin.sh). O token só existe na
// saída do terminal; o banco guarda o hash.
func RunResetPassword(ctx context.Context, d db.DB, publicURL string, nodeID int64, args []string, out io.Writer) error {
	if len(args) != 1 || strings.TrimSpace(args[0]) == "" {
		return errors.New(ResetPasswordUsage)
	}
	if publicURL == "" {
		return errors.New("defina PUBLIC_URL para montar o link")
	}
	ids, err := snowflake.New(nodeID)
	if err != nil {
		return err
	}
	q := dbgen.New(d)
	name := strings.ToLower(strings.TrimPrefix(strings.TrimSpace(args[0]), "@"))
	row, err := q.AdminFindUserForReset(ctx, name)
	if errors.Is(err, pgx.ErrNoRows) {
		return fmt.Errorf("usuário %q não existe", args[0])
	}
	if err != nil {
		return fmt.Errorf("buscar usuário: %w", err)
	}
	raw, hash, err := NewToken()
	if err != nil {
		return err
	}
	if err := NewStore(d).CreateToken(ctx, ids.Next(), row.ID, KindPasswordReset, row.Email, hash, nowFunc().Add(ResetTTL)); err != nil {
		return err
	}
	_, _ = fmt.Fprintf(out, "Link de redefinição de senha para %s (vale 30 minutos, uso único; repasse por um canal seguro):\n%s/reset-password?token=%s\n",
		row.Username, strings.TrimRight(publicURL, "/"), raw)
	return nil
}
