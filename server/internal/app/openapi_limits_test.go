package app

import (
	"testing"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/channel"
	"github.com/devGustavoMuniz/spook/server/internal/dm"
	"github.com/devGustavoMuniz/spook/server/internal/guild"
	"github.com/devGustavoMuniz/spook/server/internal/invite"
	"github.com/devGustavoMuniz/spook/server/internal/message"
	"github.com/devGustavoMuniz/spook/server/internal/presence"
	"github.com/devGustavoMuniz/spook/server/internal/user"
)

// O service é a fonte da regra; o OpenAPI (e o cliente/Zod gerados dele) precisa anunciar o mesmo limite,
// senão o cliente valida diferente do servidor. Cada linha liga um campo do contrato a uma constante do service.
// Exceção deliberada: attachment_ids não tem maxItems no contrato; o service recusa mais de 10 com uma mensagem em pt-br
// ("no máximo 10 anexos") que o schema genérico do huma trocaria por "expected array length <= 10".
func TestOpenAPILimitsMatchServices(t *testing.T) {
	schemas := buildOpenAPI().Components.Schemas.Map()
	field := func(schema, name string) *huma.Schema {
		t.Helper()
		s, ok := schemas[schema]
		if !ok {
			t.Fatalf("schema %s não existe no OpenAPI (renomeado? atualize este teste)", schema)
		}
		p, ok := s.Properties[name]
		if !ok {
			t.Fatalf("%s.%s não existe no OpenAPI", schema, name)
		}
		return p
	}
	wantInt := func(what string, got *int, want int) {
		t.Helper()
		if got == nil || *got != want {
			t.Errorf("%s: OpenAPI anuncia %v, o service aplica %d", what, deref(got), want)
		}
	}
	wantMax := func(what string, got *float64, want int64) {
		t.Helper()
		if got == nil || int64(*got) != want {
			t.Errorf("%s: OpenAPI anuncia %v, o service aplica %d", what, got, want)
		}
	}

	wantInt("CustomStatus.text maxLength", field("CustomStatus", "text").MaxLength, presence.MaxCustomTextRunes)
	wantInt("CustomStatus.emoji maxLength", field("CustomStatus", "emoji").MaxLength, presence.MaxCustomEmojiRunes)
	wantInt("SendBody.content maxLength", field("SendBody", "content").MaxLength, message.MaxContentRunes)
	wantInt("ContentBody.content maxLength", field("ContentBody", "content").MaxLength, message.MaxContentRunes)
	wantInt("OpenInputBody.recipient_ids maxItems", field("OpenInputBody", "recipient_ids").MaxItems, dm.MaxParticipants-1)
	wantInt("UpdateChannelInputBody.topic maxLength", field("UpdateChannelInputBody", "topic").MaxLength, channel.MaxTopicRunes)
	wantMax("AvatarInputBody.size maximum", field("AvatarInputBody", "size").Maximum, user.MaxAvatarBytes)
	wantMax("RequestGuildIconUploadRequest.size maximum", field("RequestGuildIconUploadRequest", "size").Maximum, guild.MaxIconBytes)
	wantMax("CreateInviteRequest.max_uses maximum", field("CreateInviteRequest", "max_uses").Maximum, invite.MaxMaxUses)
	wantMax("CreateInviteRequest.expires_in maximum", field("CreateInviteRequest", "expires_in").Maximum, int64(invite.MaxExpiresIn.Seconds()))

	// limit da listagem de mensagens.
	op := buildOpenAPI().Paths["/api/channels/{channel_id}/messages"].Get
	if op == nil {
		t.Fatal("GET /api/channels/{channel_id}/messages não existe no OpenAPI")
	}
	var found bool
	for _, p := range op.Parameters {
		if p.Name == "limit" && p.In == "query" {
			found = true
			wantMax("GET messages ?limit maximum", p.Schema.Maximum, message.MaxPageSize)
		}
	}
	if !found {
		t.Error("GET messages: parâmetro limit não encontrado")
	}
}

func deref(p *int) any {
	if p == nil {
		return nil
	}
	return *p
}
