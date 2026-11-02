-- +goose Up
-- Contas e perfil (adicional fora do SPEC). Aditiva: só colunas NULL (o Postgres não reescreve as tabelas).
--
-- Perfil: bio, pronomes e banner (imagem em banner_key OU cor sólida em banner_color).
ALTER TABLE users ADD COLUMN bio text NULL CHECK (char_length(bio) <= 190);
ALTER TABLE users ADD COLUMN pronouns text NULL CHECK (char_length(pronouns) <= 40);
ALTER TABLE users ADD COLUMN banner_key text NULL;
ALTER TABLE users ADD COLUMN banner_color integer NULL CHECK (banner_color BETWEEN 0 AND 16777215);

-- Conta excluída: a linha vira um marcador ("Usuário removido") para as mensagens continuarem com autor.
ALTER TABLE users ADD COLUMN deleted_at timestamptz NULL;

-- Confirmação de senha ("modo sudo"): vale por 10 min a partir deste instante, por sessão.
ALTER TABLE sessions ADD COLUMN password_confirmed_at timestamptz NULL;

-- +goose Down
ALTER TABLE sessions DROP COLUMN password_confirmed_at;
ALTER TABLE users DROP COLUMN deleted_at;
ALTER TABLE users DROP COLUMN banner_color;
ALTER TABLE users DROP COLUMN banner_key;
ALTER TABLE users DROP COLUMN pronouns;
ALTER TABLE users DROP COLUMN bio;
