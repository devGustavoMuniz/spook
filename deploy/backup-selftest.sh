#!/bin/sh
# shellcheck disable=SC2015,SC2012,SC2009,SC2086,SC2016  # teste: A && B || C é intencional (ok/bad); ls/ps só para contar e inspecionar
# Teste de ponta a ponta do backup e da restauração, em contêineres DESCARTÁVEIS (nada de produção, nada de dev).
# Sobe só postgres e garage do docker-compose.prod.yml num projeto próprio (spook-bkptest, volumes próprios), cria
# dados, roda backup.sh, destrói/altera, restaura com restore.sh e restore-files.sh e compara contagens, conteúdo e
# hashes. No fim derruba o projeto e apaga SÓ os volumes dele e a pasta temporária. Uso: deploy/backup-selftest.sh
# Requer Docker (imagens postgres:17-alpine, dxflrs/garage, amazon/aws-cli, rclone/rclone). Sai com 0 se tudo passou.
set -eu

SRC="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT="spook-bkptest"
R="$(mktemp -d "${TMPDIR:-/tmp}/spook-bkptest.XXXXXX")"
case "$R" in */spook-bkptest.??????) ;; *) echo "pasta temporária inesperada: $R" >&2; exit 1 ;; esac
PASS=0; FAIL=0

say() { printf '\n== %s\n' "$*"; }
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*"; }
check() { # check "descrição" comando...
  d="$1"; shift
  if "$@" > /dev/null 2>&1; then ok "$d"; else bad "$d"; fi
}
sha() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }

export COMPOSE_PROJECT_NAME="$PROJECT"
export BACKUP_DIR="$R/backups" SPOOK_APP_DIR="$R"
cd "$R"

cleanup() {
  say "limpeza (projeto $PROJECT, volumes dele e $R)"
  (cd "$R" && docker compose --env-file .env -f deploy/docker-compose.prod.yml down -v --remove-orphans > /dev/null 2>&1) || true
  # confere que só foram tocados recursos do projeto de teste
  if [ -n "$(docker volume ls -q --filter "label=com.docker.compose.project=$PROJECT")" ]; then echo "AVISO: sobraram volumes do projeto $PROJECT" >&2; fi
  rm -rf "${R:?}"
}
trap cleanup EXIT

say "preparando raiz de teste em $R"
mkdir deploy
(cd "$SRC/deploy" && tar -cf - --exclude='*.tmp' .) | (cd deploy && tar -xf -)
cat > .env <<ENV
POSTGRES_USER=spook
POSTGRES_DB=spook
POSTGRES_PASSWORD=testpw
GARAGE_RPC_SECRET=$(printf '%064d' 7)
GARAGE_CAPACITY=1GB
S3_REGION=garage
S3_BUCKET=spook
S3_ACCESS_KEY_ID=GK0123456789abcdef01234567
S3_SECRET_ACCESS_KEY=$(printf '%064d' 9)
S3_CORS_ORIGINS=http://localhost:5180
S3_ENDPOINT=http://localhost:3900
SPOOK_IMAGE=spook:selftest
LIVEKIT_API_KEY=spook
LIVEKIT_API_SECRET=testsecret
CLOUDFLARE_TUNNEL_TOKEN=x
ENV
chmod 600 .env
C="docker compose --env-file .env -f deploy/docker-compose.prod.yml"
psql_q() { $C exec -T postgres psql -U spook -d "${2:-spook}" -tA -c "$1"; }

say "subindo postgres e garage descartáveis"
$C up -d --wait postgres garage > /dev/null
COMPOSE_ENV_FILE=.env COMPOSE_FILE=deploy/docker-compose.prod.yml sh deploy/garage-init.sh > /dev/null
ok "stack de teste de pé (projeto $PROJECT)"

say "dados de teste"
psql_q "CREATE TABLE users (id bigint primary key, username text not null, created_at timestamptz default now())" > /dev/null
psql_q "CREATE TABLE messages (id bigint primary key, author bigint references users(id), body text not null)" > /dev/null
psql_q "INSERT INTO users SELECT g, 'user_'||g FROM generate_series(1,50) g" > /dev/null
psql_q "INSERT INTO messages SELECT g, 1+g%50, 'mensagem número '||g||' — ação, coração' FROM generate_series(1,5000) g" > /dev/null
fingerprint() { psql_q "SELECT (SELECT count(*) FROM users)||'/'||(SELECT count(*) FROM messages)||'/'||(SELECT md5(string_agg(id||body, '|' ORDER BY id)) FROM messages)" "${1:-spook}"; }
ORIG="$(fingerprint)"
echo "  fingerprint original (users/messages/md5): $ORIG"

mkdir seed
head -c 3145728 /dev/urandom > seed/binario.bin
printf 'olá, mundo\n' > seed/texto.txt
mkdir -p seed/sub; head -c 1000 /dev/urandom > seed/sub/pequeno.dat
H_BIN="$(sha seed/binario.bin)"; H_TXT="$(sha seed/texto.txt)"; H_SUB="$(sha seed/sub/pequeno.dat)"
# shellcheck source=backup-lib.sh
. ./deploy/backup-lib.sh
S3_CLI_DOCKER_ARGS="-v $R/seed:/seed:ro" s3_cli s3 sync --only-show-errors /seed "s3://spook/uploads" > /dev/null
ok "3 objetos enviados ao bucket (uploads/)"

say "1. backup.sh"
set +e; sh deploy/backup.sh > out1.log 2>&1; rc=$?; set -e
tail -n 8 out1.log | sed 's/^/  | /'
[ "$rc" -eq 0 ] && ok "backup.sh saiu 0" || bad "backup.sh saiu $rc"
DUMP="$(ls "$BACKUP_DIR"/db/spook-*.dump | tail -n1)"
check "dump existe e tem conteúdo" test -s "$DUMP"
case "$(ls -l "$DUMP" | cut -c1-10)" in -rw-------) ok "dump com permissão 600" ;; *) bad "permissão do dump" ;; esac
check "pg_restore --list do dump" sh -c "$C exec -T postgres pg_restore --list < '$DUMP'"
check "LAST_OK escrito" test -s "$BACKUP_DIR/LAST_OK"
[ "$(sha "$BACKUP_DIR/files/uploads/binario.bin")" = "$H_BIN" ] && ok "arquivo binário no espelho com o mesmo hash" || bad "hash do binário no espelho"
[ "$(sha "$BACKUP_DIR/files/uploads/sub/pequeno.dat")" = "$H_SUB" ] && ok "objeto em subpasta no espelho" || bad "subpasta no espelho"
if ps -axww 2>/dev/null | grep -q '[t]estpw'; then bad "senha apareceu no ps"; else ok "senha do Postgres não aparece no ps"; fi
check "backup-status.sh sai 0 (recente)" sh deploy/backup-status.sh --verify

say "2. lock: segunda execução simultânea não faz nada"
sleep 60 & LP=$!
mkdir "$BACKUP_DIR/.lock"; echo "$LP" > "$BACKUP_DIR/.lock/pid"
N0="$(ls "$BACKUP_DIR"/db/spook-*.dump | wc -l | tr -d ' ')"
sh deploy/backup.sh > out2.log 2>&1 && ok "saiu 0 com lock ativo" || bad "saída com lock ativo"
grep -q 'outro backup está rodando' out2.log && ok "mensagem de lock" || bad "mensagem de lock"
[ "$(ls "$BACKUP_DIR"/db/spook-*.dump | wc -l | tr -d ' ')" = "$N0" ] && ok "nenhum dump novo com lock ativo" || bad "dump criado com lock ativo"
kill "$LP" 2>/dev/null || true
echo 999999 > "$BACKUP_DIR/.lock/pid" # lock órfão: pid que não existe

say "3. mutação: apaga dados e arquivos"
psql_q "DELETE FROM messages WHERE id % 2 = 0" > /dev/null
psql_q "DROP TABLE users CASCADE" > /dev/null
s3_cli s3 rm --recursive --only-show-errors s3://spook/ > /dev/null
rm -rf "$R/seed"
[ "$(s3_cli s3 ls --recursive s3://spook/ | wc -l | tr -d ' ')" = 0 ] && ok "bucket vazio" || bad "bucket não ficou vazio"

say "4. restore.sh em banco novo (o banco em uso não é tocado)"
set +e; sh deploy/restore.sh "$DUMP" --into spook_restore_t > out3.log 2>&1; rc=$?; set -e
tail -n 3 out3.log | sed 's/^/  | /'
[ "$rc" -eq 0 ] && ok "restore.sh saiu 0" || bad "restore.sh saiu $rc"
[ "$(fingerprint spook_restore_t)" = "$ORIG" ] && ok "contagens e md5 das mensagens idênticos ao original" || bad "fingerprint restaurado: $(fingerprint spook_restore_t)"
[ "$(psql_q "SELECT count(*) FROM messages")" = 2500 ] && ok "banco em uso continua alterado (2500 mensagens)" || bad "banco em uso foi tocado"
sh deploy/restore.sh "$DUMP" --into spook_restore_t > out3b.log 2>&1 && bad "restore em banco existente deveria falhar" || ok "restore recusa banco já existente"
sh deploy/restore.sh "$DUMP" --into spook > out3c.log 2>&1 && bad "restore no banco em uso deveria falhar" || ok "restore recusa o banco em uso sem --confirm-replace"

say "5. restore-files.sh"
set +e; sh deploy/restore-files.sh > out4.log 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "restore-files.sh saiu 0" || bad "restore-files.sh saiu $rc"
mkdir back
S3_CLI_DOCKER_ARGS="-v $R/back:/back" s3_cli s3 sync --only-show-errors s3://spook /back > /dev/null
[ "$(sha back/uploads/binario.bin)" = "$H_BIN" ] && ok "binário de 3 MB voltou ao bucket com o mesmo hash" || bad "hash do binário restaurado"
[ "$(sha back/uploads/texto.txt)" = "$H_TXT" ] && ok "texto voltou com o mesmo hash" || bad "hash do texto restaurado"
[ "$(sha back/uploads/sub/pequeno.dat)" = "$H_SUB" ] && ok "objeto de subpasta voltou" || bad "hash do pequeno restaurado"

say "6. restore.sh --confirm-replace (banco real substituído; o antigo fica guardado)"
set +e; sh deploy/restore.sh "$DUMP" --confirm-replace > out5.log 2>&1; rc=$?; set -e
tail -n 2 out5.log | sed 's/^/  | /'
[ "$rc" -eq 0 ] && ok "replace saiu 0" || bad "replace saiu $rc"
[ "$(fingerprint)" = "$ORIG" ] && ok "banco real agora idêntico ao original" || bad "banco real após replace: $(fingerprint)"
[ "$(psql_q "SELECT count(*) FROM pg_database WHERE datname LIKE 'spook_pre_restore_%'" postgres)" = 1 ] && ok "banco anterior guardado (spook_pre_restore_*)" || bad "banco anterior não guardado"

say "7. retenção (dumps falsos de jan e fev/2026 + o real)"
for d in $(seq 1 31); do cp "$DUMP" "$BACKUP_DIR/db/spook-202601$(printf %02d "$d")-030000.dump"; done
for d in $(seq 1 28); do cp "$DUMP" "$BACKUP_DIR/db/spook-202602$(printf %02d "$d")-030000.dump"; done
echo "nao-sou-dump" > "$BACKUP_DIR/db/outro-arquivo.txt"
sleep 1
set +e; sh deploy/backup.sh > out6.log 2>&1; rc=$?; set -e
grep 'retenção' out6.log | sed 's/^/  | /'
[ "$rc" -eq 0 ] && ok "backup.sh (com lock órfão) saiu 0" || bad "backup.sh saiu $rc"
has() { test -f "$BACKUP_DIR/db/spook-$1-030000.dump"; }
check "diários mantidos (23 a 28/02)" sh -c 'for d in 23 24 25 26 27 28; do test -f "'"$BACKUP_DIR"'/db/spook-202602$d-030000.dump" || exit 1; done'
check "domingos mantidos (22/02 e 15/02)" sh -c 'test -f "'"$BACKUP_DIR"'/db/spook-20260222-030000.dump" && test -f "'"$BACKUP_DIR"'/db/spook-20260215-030000.dump"'
check "primeiros do mês mantidos (01/01 e 01/02)" sh -c 'test -f "'"$BACKUP_DIR"'/db/spook-20260101-030000.dump" && test -f "'"$BACKUP_DIR"'/db/spook-20260201-030000.dump"'
has 20260115 && bad "15/01 deveria ter sido apagado" || ok "dump excedente (15/01) apagado"
has 20260210 && bad "10/02 deveria ter sido apagado" || ok "dump excedente (10/02) apagado"
test -f "$BACKUP_DIR/db/outro-arquivo.txt" && ok "arquivo fora do padrão não foi tocado" || bad "arquivo fora do padrão foi apagado"
N="$(ls "$BACKUP_DIR"/db/spook-*.dump | wc -l | tr -d ' ')"
[ "$N" -le 14 ] && [ "$N" -ge 9 ] && ok "total de dumps após retenção: $N (<= 14)" || bad "total inesperado: $N"
[ "$(ls "$BACKUP_DIR"/db/spook-2026[01]*.dump 2>/dev/null | wc -l | tr -d ' ')" -ge 1 ] || true

say "8. offsite (rclone, remote 'local') com e sem criptografia"
mkdir "$R/offsite"
export RCLONE_CONFIG_OFFSITE_TYPE=local
export BACKUP_RCLONE_DOCKER_ARGS="-v $R/offsite:/offsite"
export BACKUP_REMOTE="offsite:/offsite/plain"
sleep 1
set +e; sh deploy/backup.sh > out7.log 2>&1; rc=$?; set -e
[ "$rc" -eq 0 ] && ok "backup.sh com offsite saiu 0" || { bad "backup.sh com offsite saiu $rc"; tail -n 5 out7.log; }
grep -q '^offsite=ok' "$BACKUP_DIR/LAST_OK" && ok "LAST_OK registra offsite=ok" || bad "LAST_OK sem offsite=ok"
[ "$(ls "$R"/offsite/plain/db/*.dump | wc -l | tr -d ' ')" = "$(ls "$BACKUP_DIR"/db/spook-*.dump | wc -l | tr -d ' ')" ] && ok "dumps espelhados no offsite" || bad "dumps no offsite"
[ "$(sha "$R/offsite/plain/files/uploads/binario.bin")" = "$H_BIN" ] && ok "arquivo no offsite com o mesmo hash" || bad "hash no offsite"
grep -q 'testpw\|GK0123' out7.log && bad "segredo/variável no log" || ok "log do offsite sem credenciais"
OBS="$(docker run --rm rclone/rclone:1.69.3 obscure 'senha-de-teste')"
export RCLONE_CONFIG_ENC_TYPE=crypt RCLONE_CONFIG_ENC_REMOTE="offsite:/offsite/enc" RCLONE_CONFIG_ENC_PASSWORD="$OBS"
export BACKUP_REMOTE="enc:"
sleep 1
sh deploy/backup.sh > out8.log 2>&1 && ok "backup.sh com rclone crypt saiu 0" || bad "backup.sh com crypt falhou"
if ls "$R"/offsite/enc/* > /dev/null 2>&1 && [ -z "$(find "$R/offsite/enc" -name '*spook-*' -o -name '*binario*')" ]; then ok "nomes e conteúdo cifrados no destino"; else bad "crypt não cifrou os nomes"; fi
unset BACKUP_REMOTE RCLONE_CONFIG_OFFSITE_TYPE RCLONE_CONFIG_ENC_TYPE RCLONE_CONFIG_ENC_REMOTE RCLONE_CONFIG_ENC_PASSWORD BACKUP_RCLONE_DOCKER_ARGS
export BACKUP_REMOTE="offsite:/offsite/x" RCLONE_CONFIG_OFFSITE_TYPE=local BACKUP_RCLONE_DOCKER_ARGS="-v $R/nope:/offsite:ro"
sleep 1
set +e; sh deploy/backup.sh > out9.log 2>&1; rc=$?; set -e
[ "$rc" -eq 2 ] && ok "falha só do offsite sai 2 (backup local ok)" || bad "falha do offsite saiu $rc"
grep -q '^offsite=FAILED' "$BACKUP_DIR/LAST_OK" && ok "LAST_OK registra offsite=FAILED" || bad "LAST_OK sem FAILED"
unset BACKUP_REMOTE RCLONE_CONFIG_OFFSITE_TYPE BACKUP_RCLONE_DOCKER_ARGS

say "9. falhas"
$C stop postgres > /dev/null 2>&1
sleep 1
set +e; sh deploy/backup.sh > out10.log 2>&1; rc=$?; set -e
[ "$rc" -ne 0 ] && ok "backup.sh com Postgres parado sai $rc" || bad "backup.sh deveria falhar"
grep -q 'FALHA' out10.log && ok "linha clara de FALHA no log" || bad "sem linha de FALHA"
test -f "$BACKUP_DIR/LAST_FAIL" && ok "LAST_FAIL escrito" || bad "sem LAST_FAIL"
[ -z "$(ls -A "$BACKUP_DIR"/db/.spook-*.tmp 2> /dev/null || true)" ] && ok "nenhum temporário órfão" || bad "temporário órfão"
$C start postgres > /dev/null 2>&1
sed -i.bak 's/^epoch=.*/epoch=1000000000/' "$BACKUP_DIR/LAST_OK"
sh deploy/backup-status.sh > out11.log 2>&1 && bad "status deveria falhar com backup velho" || ok "backup-status.sh sai != 0 com backup de mais de 36 h"

say "resultado"
printf '  %s passaram, %s falharam\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
