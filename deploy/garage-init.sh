#!/usr/bin/env sh
# Inicializa o Garage de forma idempotente: layout, bucket, chave de acesso e CORS.
# Uso: deploy/garage-init.sh   (o serviço `garage` do Compose precisa estar saudável)
set -eu

cd "$(dirname "$0")/.."
[ -f .env ] && set -a && . ./.env && set +a

BUCKET="${S3_BUCKET:-spook}"
KEY_ID="${S3_ACCESS_KEY_ID:?defina S3_ACCESS_KEY_ID (GK + 24 hex)}"
KEY_SECRET="${S3_SECRET_ACCESS_KEY:?defina S3_SECRET_ACCESS_KEY (64 hex)}"
CAPACITY="${GARAGE_CAPACITY:-10GB}"
CORS_ORIGINS="${S3_CORS_ORIGINS:-http://localhost:5180}"
AWS_CLI_IMAGE="amazon/aws-cli:2.39.3"

compose="docker compose -f deploy/docker-compose.yml"
garage() { $compose exec -T garage /garage "$@"; }

# 1. Layout (um nó só, replication_factor = 1)
if garage status | grep -q "NO ROLE ASSIGNED"; then
  node_id="$(garage node id -q | cut -d@ -f1)"
  garage layout assign -z dc1 -c "$CAPACITY" "$node_id"
  garage layout apply --version 1
fi

# 2. Bucket
garage bucket info "$BUCKET" >/dev/null 2>&1 || garage bucket create "$BUCKET"

# 3. Chave de acesso fixa (vem do .env), com permissão total no bucket
garage key info "$KEY_ID" >/dev/null 2>&1 || garage key import --yes -n spook-app "$KEY_ID" "$KEY_SECRET"
garage bucket allow --read --write --owner "$BUCKET" --key "$KEY_ID"

# 4. CORS para o front subir direto com URL pré-assinada
cors="$(printf '{"CORSRules":[{"AllowedOrigins":["%s"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["*"],"ExposeHeaders":["ETag"],"MaxAgeSeconds":3000}]}' \
  "$(printf '%s' "$CORS_ORIGINS" | sed 's/,/","/g')")"
network="$($compose ps -q garage | xargs docker inspect -f '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
docker run --rm --network "$network" \
  -e AWS_ACCESS_KEY_ID="$KEY_ID" -e AWS_SECRET_ACCESS_KEY="$KEY_SECRET" -e AWS_DEFAULT_REGION=garage \
  "$AWS_CLI_IMAGE" --endpoint-url http://garage:3900 s3api put-bucket-cors \
  --bucket "$BUCKET" --cors-configuration "$cors"

echo "Garage pronto: bucket=$BUCKET key=$KEY_ID"
