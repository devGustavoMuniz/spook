-- +goose Up
-- Menções em massa, mensagem de sistema, tópico de canal e canal de sistema (adicional fora do SPEC).
-- Aditiva: só colunas novas com default. Nenhum cargo existente ganha MENTION_EVERYONE (bit 19).

-- Cargo mencionável: com true, qualquer pessoa com acesso ao canal pode escrever @NomeDoCargo e notificar o cargo.
ALTER TABLE roles ADD COLUMN mentionable boolean NOT NULL DEFAULT false;

-- kind: 'default' (mensagem comum) ou 'member_join' (mensagem de sistema "fulano entrou").
-- mention_everyone / mention_here / mention_role_ids: resolvidos no envio (só valem se o autor podia mencionar).
ALTER TABLE messages ADD COLUMN kind text NOT NULL DEFAULT 'default' CHECK (kind IN ('default', 'member_join'));
ALTER TABLE messages ADD COLUMN mention_everyone boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN mention_here boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN mention_role_ids bigint[] NOT NULL DEFAULT '{}';

-- Canal de sistema (mensagens de boas-vindas). NULL = o primeiro canal de texto do servidor.
ALTER TABLE guilds ADD COLUMN system_channel_id bigint NULL REFERENCES channels (id) ON DELETE SET NULL;
ALTER TABLE guilds ADD COLUMN system_join_enabled boolean NOT NULL DEFAULT true;

ALTER TABLE channels ADD COLUMN topic text NULL CHECK (topic IS NULL OR char_length(topic) <= 1024);

-- Por servidor: ignorar @everyone e @here (não soma menção nem avisa).
ALTER TABLE notification_settings ADD COLUMN suppress_everyone boolean NOT NULL DEFAULT false;

-- +goose Down
ALTER TABLE notification_settings DROP COLUMN suppress_everyone;
ALTER TABLE channels DROP COLUMN topic;
ALTER TABLE guilds DROP COLUMN system_join_enabled;
ALTER TABLE guilds DROP COLUMN system_channel_id;
ALTER TABLE messages DROP COLUMN mention_role_ids;
ALTER TABLE messages DROP COLUMN mention_here;
ALTER TABLE messages DROP COLUMN mention_everyone;
ALTER TABLE messages DROP COLUMN kind;
ALTER TABLE roles DROP COLUMN mentionable;
