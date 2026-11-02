package user

import "strings"

// reservedUsernames são nomes que dariam a impressão de conta oficial ou colidiriam com menções e rotas.
// Vale só para NOVOS cadastros (e futuras trocas de username); contas existentes não são afetadas.
var reservedUsernames = map[string]struct{}{}

func init() {
	for _, n := range []string{
		"admin", "administrator", "administrador", "root", "spook", "spooky", "suporte", "support", "system", "sistema",
		"everyone", "here", "moderator", "moderador", "mod", "mods", "staff", "null", "undefined", "api", "www",
		"help", "ajuda", "security", "seguranca", "contato", "contact", "official", "oficial", "bot", "webmaster",
		"postmaster", "hostmaster", "noreply", "no-reply", "owner", "dono", "me", "self", "anonymous", "anonimo",
		"deleted", "removido", "login", "logout", "register", "settings", "status", "billing", "abuse",
	} {
		reservedUsernames[n] = struct{}{}
	}
}

// IsReservedUsername compara sem diferenciar maiúsculas/minúsculas. Nomes de contas excluídas
// ("removido_<id>") também são reservados, para ninguém se passar por "Usuário removido".
func IsReservedUsername(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	if _, ok := reservedUsernames[n]; ok {
		return true
	}
	return strings.HasPrefix(n, "removido_")
}
