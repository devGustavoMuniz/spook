// Package dm cuida das mensagens diretas (RF07): DM 1:1 (única por par de usuários) e DM em
// grupo (dono, até 10 participantes). As mensagens em si são do pacote message, que acessa as
// DMs por channel.Service.Authorize; este pacote só gere canais e participantes.
package dm

import "github.com/devGustavoMuniz/spook/server/internal/platform/apperr"

// MaxParticipants é o limite de participantes de uma DM em grupo, contando o dono (SPEC 7.4).
const MaxParticipants = 10

var (
	ErrNotFound = apperr.NotFound("canal não encontrado")
	// ErrCannotDM serve para "sem servidor em comum nem amizade" e para bloqueio, de propósito com a mesma mensagem:
	// quem foi bloqueado não descobre o bloqueio.
	ErrCannotDM   = apperr.Forbidden("não foi possível abrir uma DM com essa pessoa: só é possível com quem compartilha um servidor com você ou é seu amigo")
	ErrOnlyOwner  = apperr.Forbidden("só o dono da DM em grupo pode fazer isso")
	ErrGroupFull  = apperr.Conflict("a DM em grupo já tem 10 participantes")
	ErrOwnerStays = apperr.Conflict("o dono não pode sair da DM em grupo nem ser removido")
	ErrNotAGroup  = apperr.Invalid("DMs 1:1 não têm participantes a adicionar ou remover")
	ErrSelf       = apperr.Invalid("você não pode abrir uma DM consigo mesmo")
)
