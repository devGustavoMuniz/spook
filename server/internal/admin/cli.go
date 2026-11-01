package admin

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/devGustavoMuniz/spook/server/internal/platform/db"
	"github.com/devGustavoMuniz/spook/server/internal/platform/dbgen"
)

// Uso do comando `spook admin`, exibido em erro de argumentos.
const Usage = "uso: spook admin grant <username> | revoke <username> | list"

// RunCLI executa `spook admin grant|revoke|list`: gerencia quem é administrador sem passar pelo
// deploy. Roda no container do backend (docker exec) e escreve o resultado em out.
func RunCLI(ctx context.Context, d db.DB, args []string, out io.Writer) error {
	q := dbgen.New(d)
	if len(args) == 0 {
		return errors.New(Usage)
	}
	switch args[0] {
	case "list":
		names, err := q.AdminListAdmins(ctx)
		if err != nil {
			return fmt.Errorf("listar administradores: %w", err)
		}
		if len(names) == 0 {
			_, _ = fmt.Fprintln(out, "nenhum administrador")
			return nil
		}
		_, _ = fmt.Fprintln(out, strings.Join(names, "\n"))
		return nil
	case "grant", "revoke":
		if len(args) != 2 || strings.TrimSpace(args[1]) == "" {
			return errors.New(Usage)
		}
		grant := args[0] == "grant"
		name, err := q.AdminSetAdmin(ctx, dbgen.AdminSetAdminParams{IsAdmin: grant, Username: strings.TrimPrefix(strings.TrimSpace(args[1]), "@")})
		if errors.Is(err, pgx.ErrNoRows) {
			return fmt.Errorf("usuário %q não existe", args[1])
		}
		if err != nil {
			return fmt.Errorf("atualizar administrador: %w", err)
		}
		if grant {
			_, _ = fmt.Fprintf(out, "%s agora é administrador\n", name)
		} else {
			_, _ = fmt.Fprintf(out, "%s deixou de ser administrador\n", name)
		}
		return nil
	default:
		return errors.New(Usage)
	}
}
