// Package account cuida da exclusão da própria conta: recusa dono de servidor, anonimiza o usuário
// (as mensagens ficam, com autor "Usuário removido"), apaga o que é só dele e remove os arquivos do S3.
package account

import (
	"errors"
	"fmt"
	"strconv"
)

// GuildRef identifica um servidor do qual o usuário é dono.
type GuildRef struct {
	ID   int64
	Name string
}

// OwnsGuildsError: não dá para excluir a conta enquanto houver servidor próprio.
type OwnsGuildsError struct{ Guilds []GuildRef }

func (e *OwnsGuildsError) Error() string {
	return fmt.Sprintf("você é dono de %d servidor(es): transfira ou exclua antes", len(e.Guilds))
}

var ErrWrongPassword = errors.New("senha incorreta")

// Result é o que a exclusão alterou, para o service avisar o gateway depois do commit.
type Result struct {
	GuildIDs       []int64  // servidores dos quais o usuário saiu
	GroupChannels  []int64  // DMs em grupo que continuam existindo (os demais precisam atualizar a lista)
	FileKeys       []string // avatar e banner a apagar do S3
	AnonymizedName string
}

// Nomes usados no marcador "Usuário removido".
func removedUsername(id int64) string { return "removido_" + strconv.FormatInt(id, 10) }
func removedEmail(id int64) string    { return removedUsername(id) + "@removed.invalid" }
