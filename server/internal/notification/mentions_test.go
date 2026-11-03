package notification

import (
	"reflect"
	"strings"
	"testing"
)

func TestParseMentions(t *testing.T) {
	cases := []struct {
		name, in string
		want     []string
	}{
		{"simples", "oi @maria", []string{"maria"}},
		{"sem diferenciar maiúsculas", "oi @Maria_Silva e @JOAO.dev", []string{"maria_silva", "joao.dev"}},
		{"início do texto", "@ana vem aqui", []string{"ana"}},
		{"sem mentions", "bom dia a todos", nil},
		{"e-mail não é menção", "fale com joao@gmail.com ou maria.silva@empresa.com.br", nil},
		{"arroba solto", "@ sozinho e @", nil},
		{"um caractere só", "oi @a", nil},
		{"dois caracteres bastam", "oi @ab", []string{"ab"}},
		{"pontuação depois", "oi @maria, @joao! e @ana? (@bia) \"@cris\"", []string{"maria", "joao", "ana", "bia", "cris"}},
		{"ponto final vira duas candidatas", "obrigado @maria.", []string{"maria.", "maria"}},
		{"duplicatas", "@maria @MARIA @maria", []string{"maria"}},
		{"colado a palavra", "xyz@maria e a@b", nil},
		{"seguido de letra acentuada", "oi @mariaé", nil},
		{"seguido de arroba", "oi @maria@dominio", nil},
		{"traço delimita", "oi @maria-silva", []string{"maria"}},
		{"duas arrobas seguidas", "@@maria", nil},
		{"quebra de linha", "oi\n@maria\n@joao", []string{"maria", "joao"}},
		{"nome grande demais", "@" + strings.Repeat("a", 33), nil},
		{"nome com 32", "@" + strings.Repeat("a", 32), []string{strings.Repeat("a", 32)}},
		{"everyone e here saem do parser de usernames (Resolve os descarta; ParseBulk os trata)", "@everyone @here", []string{"everyone", "here"}},
		{"emoji antes", "👋@maria", []string{"maria"}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := ParseMentions(c.in)
			if !reflect.DeepEqual(got, c.want) {
				t.Fatalf("ParseMentions(%q) = %v, esperado %v", c.in, got, c.want)
			}
		})
	}
}

func TestParseMentionsLimitsTokensTo20(t *testing.T) {
	var b strings.Builder
	for i := 0; i < 30; i++ {
		b.WriteString("@user")
		b.WriteString(string(rune('a' + i%26)))
		b.WriteString(string(rune('a' + i/26)))
		b.WriteString(" ")
	}
	got := ParseMentions(b.String())
	if len(got) != MaxMentions {
		t.Fatalf("%d menções, esperado %d: %v", len(got), MaxMentions, got)
	}
	if got[0] != "useraa" || got[19] != "usert"+"a" {
		t.Fatalf("ordem/limite inesperados: %v", got)
	}
}

func TestParseMentionsDuplicatesDoNotBypassTheLimit(t *testing.T) {
	got := ParseMentions(strings.Repeat("@ana ", 100) + "@bia")
	if !reflect.DeepEqual(got, []string{"ana"}) { // 100 repetições esgotam os 20 tokens antes de @bia
		t.Fatalf("got %v", got)
	}
}
