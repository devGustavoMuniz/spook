package notification

import (
	"slices"
	"strings"
	"unicode"
	"unicode/utf8"
)

const (
	minUsername = 2
	maxUsername = 32
)

func isNameByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '.'
}

// ParseMentions devolve os nomes citados como @username no texto, em minúsculas e sem repetição, na
// ordem em que aparecem. Regras: o @ não pode vir colado a uma letra, dígito, "_", "." ou "@" (e-mails
// como a@b.com não valem); o nome tem 2 a 32 caracteres de [a-z0-9_.] (sem diferenciar maiúsculas) e
// precisa terminar o "token" (não pode continuar em letra ou @). Um ponto no fim ("@maria.") pode ser a
// pontuação da frase ou parte do nome: nesse caso as duas formas são candidatas. No máximo MaxMentions
// citações (tokens) por mensagem; @everyone e @here NÃO são usernames (são reservados; ver ParseBulk).
func ParseMentions(content string) []string {
	var out []string
	seen := map[string]struct{}{}
	add := func(name string) bool {
		if len(name) < minUsername || len(name) > maxUsername {
			return false
		}
		name = strings.ToLower(name)
		if _, dup := seen[name]; !dup {
			seen[name] = struct{}{}
			out = append(out, name)
		}
		return true
	}

	tokens := 0
	prev := rune(-1)
	for i := 0; i < len(content); {
		r, w := utf8.DecodeRuneInString(content[i:])
		if r != '@' || blocksMentionStart(prev) {
			prev, i = r, i+w
			continue
		}
		j := i + 1
		for j < len(content) && isNameByte(content[j]) {
			j++
		}
		next, _ := utf8.DecodeRuneInString(content[j:])
		if j < len(content) && (unicode.IsLetter(next) || unicode.IsDigit(next) || next == '@') {
			prev, i = r, i+w // colado a outro caractere de palavra: não é uma citação delimitada
			continue
		}
		token := content[i+1 : j]
		ok := add(token)
		if stripped := strings.TrimRight(token, "."); stripped != token {
			ok = add(stripped) || ok
		}
		if ok {
			tokens++
			if tokens >= MaxMentions {
				break
			}
		}
		prev, i = r, i+w // continua logo depois do @ (o token vira texto comum)
	}
	return out
}

// blocksMentionStart diz se o caractere antes do @ o torna parte de outra palavra (e-mail, etc.).
func blocksMentionStart(prev rune) bool {
	if prev < 0 {
		return false
	}
	return unicode.IsLetter(prev) || unicode.IsDigit(prev) || prev == '_' || prev == '.' || prev == '@'
}

// RoleRef é um cargo do servidor candidato a menção (@NomeDoCargo).
type RoleRef struct {
	ID          int64
	Name        string
	Mentionable bool
}

// BulkMentions são as menções em massa de um texto: @everyone, @here e cargos.
type BulkMentions struct {
	Everyone bool
	Here     bool
	RoleIDs  []int64
}

// Any diz se há alguma menção em massa.
func (b BulkMentions) Any() bool { return b.Everyone || b.Here || len(b.RoleIDs) > 0 }

// Mass diz se há @everyone ou @here (as que têm rate limit e a permissão MENTION_EVERYONE).
func (b BulkMentions) Mass() bool { return b.Everyone || b.Here }

// endsToken diz se o que vem logo depois de uma menção a encerra (fim do texto, espaço ou pontuação).
func endsToken(content string, at int) bool {
	if at >= len(content) {
		return true
	}
	next, _ := utf8.DecodeRuneInString(content[at:])
	return !unicode.IsLetter(next) && !unicode.IsDigit(next) && next != '_' && next != '@'
}

// ParseBulk acha @everyone, @here e @NomeDoCargo no texto. Regras: o @ não pode vir colado a uma palavra
// (e-mails não valem); a menção precisa terminar o token (espaço, pontuação ou fim); everyone e here
// valem sem diferenciar maiúsculas; o nome do cargo pode ter espaços e é comparado sem diferenciar maiúsculas,
// preferindo o nome mais longo ("@Time Azul" vence "@Time"). Só entram cargos que existem (roles); quem filtra
// os que o autor pode mencionar é o chamador. No máximo MaxMentions cargos distintos.
func ParseBulk(content string, roles []RoleRef) BulkMentions {
	var out BulkMentions
	if !strings.Contains(content, "@") {
		return out
	}
	byLen := make([]RoleRef, len(roles))
	copy(byLen, roles)
	slices.SortStableFunc(byLen, func(a, b RoleRef) int { return len(b.Name) - len(a.Name) })

	seen := map[int64]struct{}{}
	prev := rune(-1)
	for i := 0; i < len(content); {
		r, w := utf8.DecodeRuneInString(content[i:])
		if r != '@' || blocksMentionStart(prev) {
			prev, i = r, i+w
			continue
		}
		rest := content[i+1:]
		switch {
		case foldPrefixLen(rest, "everyone") > 0 && endsToken(content, i+1+len("everyone")):
			out.Everyone = true
		case foldPrefixLen(rest, "here") > 0 && endsToken(content, i+1+len("here")):
			out.Here = true
		default:
			for _, role := range byLen {
				n := foldPrefixLen(rest, role.Name)
				if role.Name == "" || n == 0 || !endsToken(content, i+1+n) {
					continue
				}
				if _, dup := seen[role.ID]; !dup && len(seen) < MaxMentions {
					seen[role.ID] = struct{}{}
					out.RoleIDs = append(out.RoleIDs, role.ID)
				}
				break
			}
		}
		prev, i = r, i+w
	}
	slices.Sort(out.RoleIDs)
	return out
}

// foldPrefixLen devolve quantos bytes de s casam com prefix sem diferenciar maiúsculas (0 = não casa).
// Compara por runas porque maiúscula e minúscula podem ter tamanhos diferentes em UTF-8.
func foldPrefixLen(s, prefix string) int {
	n := utf8.RuneCountInString(prefix)
	end, count := 0, 0
	for end < len(s) && count < n {
		_, w := utf8.DecodeRuneInString(s[end:])
		end += w
		count++
	}
	if count < n || !strings.EqualFold(s[:end], prefix) {
		return 0
	}
	return end
}
