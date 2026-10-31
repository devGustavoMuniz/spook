package notification

import (
	"encoding/json"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// BodyRunes é o tamanho máximo do corpo da notificação, em caracteres.
const BodyRunes = 120

// PushPayload é o JSON que o service worker recebe no evento `push`.
type PushPayload struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	URL   string `json:"url" doc:"Caminho do app a abrir ao clicar: /channels/<servidor>/<canal> ou /channels/@me/<canal>"`
	Tag   string `json:"tag" doc:"ID do canal: notificações do mesmo canal se substituem"`
}

// BuildPushPayload monta a notificação a partir da mensagem. Título: nome de exibição do autor (e
// "#canal · servidor" fora das DMs); corpo: o texto sem quebras de linha, truncado em BodyRunes, ou
// "📎 arquivo" para mensagem só com anexo.
func BuildPushPayload(pc PushContext, channelID int64) PushPayload {
	author := pc.DisplayName
	if author == "" {
		author = pc.Username
	}
	p := PushPayload{Title: author, Body: pushBody(pc.Content, pc.AttachmentCount), Tag: httpx.ID(channelID)}
	if pc.GuildID != nil {
		p.Title = fmt.Sprintf("%s (#%s · %s)", author, pc.ChannelName, pc.GuildName)
		p.URL = fmt.Sprintf("/channels/%d/%d", *pc.GuildID, channelID)
	} else {
		p.URL = fmt.Sprintf("/channels/@me/%d", channelID)
	}
	return p
}

func pushBody(content string, attachments int) string {
	text := strings.Join(strings.FieldsFunc(content, unicode.IsSpace), " ")
	if text == "" {
		if attachments > 0 {
			return "📎 arquivo"
		}
		return ""
	}
	return Truncate(text, BodyRunes)
}

// Truncate corta em max runes, terminando com "…" (a reticência conta dentro do limite).
func Truncate(s string, max int) string {
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)
	return strings.TrimRightFunc(string(r[:max-1]), unicode.IsSpace) + "…"
}

func (p PushPayload) JSON() []byte {
	b, _ := json.Marshal(p) // só strings: não falha
	return b
}

// notifyTargets decide quem "é notificado" por uma mensagem: nas DMs, todos os outros participantes; nos
// servidores, só os mencionados. O autor nunca entra. Os mesmos alvos recebem a soma de menções (badge) e,
// se estiverem sem sessão de gateway, o push.
func notifyTargets(authorID int64, isDM bool, participants, mentioned []int64) []int64 {
	src := mentioned
	if isDM {
		src = participants
	}
	seen := make(map[int64]struct{}, len(src))
	out := make([]int64, 0, len(src))
	for _, id := range src {
		if id == authorID {
			continue
		}
		if _, dup := seen[id]; !dup {
			seen[id] = struct{}{}
			out = append(out, id)
		}
	}
	return out
}

// pushRecipients filtra os alvos: só recebe push quem NÃO tem sessão de gateway ativa (status diferente
// de offline conta como ativo; a tolerância de 15 s da presença vale).
func pushRecipients(targets []int64, active func(userID int64) bool) []int64 {
	var out []int64
	for _, id := range targets {
		if !active(id) {
			out = append(out, id)
		}
	}
	return out
}
