package notification

import (
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
// citações (tokens) por mensagem; @everyone e @here não têm significado especial (são só usernames).
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
