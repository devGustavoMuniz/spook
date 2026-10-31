#!/usr/bin/env bash
# Receita para o teste de carga do LiveKit (Fase 5): publicadores de áudio/vídeo e assinantes simulados pelo `lk load-test`
# (imagem livekit/livekit-cli), medindo CPU/banda do servidor por participante. NÃO é executado pelo CI e NÃO deve rodar
# contra produção sem combinar a carga (Fase B do SPEC). Este script só monta e roda o comando; leia antes de usar.
#
# O `lk load-test` fala direto com o LiveKit (não passa pelo backend do Spook): ele cria a própria sala de teste e entra com um
# token assinado pela chave/segredo da API que você informa, então NÃO mexe em canais nem usuários do Spook (o nome da sala é
# livre; o padrão `bench-<epoch>` não colide com IDs de canal). Em contrapartida, não mede a emissão de token (use
# scenarios/voice-token.js) nem os webhooks.
#
# Variáveis (todas opcionais, exceto onde dito):
#   LK_URL            URL do LiveKit (padrão ws://localhost:7880, o do `pnpm dev`; em Linux/Docker use --network host, ver NETWORK)
#   LK_API_KEY        chave da API (padrão devkey, a de dev)
#   LK_API_SECRET     segredo da API (padrão: o de dev, deploy/livekit/livekit.yaml). Passe por ambiente, nunca na linha de comando.
#   ROOM              nome da sala de teste (padrão bench-<epoch>)
#   DURATION          duração (padrão 1m)
#   AUDIO_PUBLISHERS  publicadores de áudio (padrão 5)     VIDEO_PUBLISHERS  publicadores de vídeo (padrão 0)
#   SUBSCRIBERS       assinantes (padrão 10)               VIDEO_RESOLUTION  low|medium|high (padrão low)
#   NUM_PER_SECOND    ritmo de entrada de participantes por segundo (padrão 1)
#   NO_SIMULCAST      1 desliga o simulcast (padrão: ligado)       LAYOUT  speaker|3x3|4x4|5x5 (padrão speaker)
#   SIMULATE_SPEAKERS 1 dispara eventos aleatórios de quem fala (padrão desligado)
#   LK_CLI_IMAGE      padrão livekit/livekit-cli:latest (flags conferidas na v2.19.2; fixe uma tag para resultados reproduzíveis)
#   NETWORK           rede Docker do container do cli (padrão host; mac/Windows: deixe host e use host.docker.internal em LK_URL)
#   SERVER_CONTAINER  se definido (ex.: spook-livekit-1), amostra CPU/memória/rede desse container durante o teste
#   STATS_OUT         arquivo CSV das amostras (padrão /tmp/livekit-stats-<epoch>.csv)
#
# Medição de CPU/banda por participante (receita):
#   1. Com o LiveKit ocioso, anote a base: SERVER_CONTAINER amostrado sem carga (rode com AUDIO_PUBLISHERS=0 SUBSCRIBERS=0 DURATION=20s).
#   2. Rode com N participantes (ex.: AUDIO_PUBLISHERS=N/2 SUBSCRIBERS=N/2) e SERVER_CONTAINER definido. Depois da rampa
#      (N / NUM_PER_SECOND segundos), a mediana das amostras é a CPU(N) e a banda(N) (delta de rede por segundo).
#   3. Custo por participante = (CPU(N) - CPU_base) / N, e idem para a banda. Repita para N crescente (10, 25, 50, 100) e
#      registre a curva; o VPS tem 1 CPU compartilhada e o container do LiveKit é limitado a 0,5 CPU / 512M em produção.
#   4. A mídia sai direto pelo IP público (7891/tcp, 7892/udp); em produção rode o cli de uma máquina de fora, não do VPS.
#
# Exemplos:
#   LK_API_SECRET=... LK_URL=wss://spook-rtc.dottadigital.com ... (produção: só com a carga combinada!)
#   SERVER_CONTAINER=spook-livekit-1 AUDIO_PUBLISHERS=10 SUBSCRIBERS=20 DURATION=2m bench/scripts/livekit-load-test.sh   # local
set -euo pipefail

LK_URL="${LK_URL:-ws://localhost:7880}"
LK_API_KEY="${LK_API_KEY:-devkey}"
# Segredo de dev (deploy/livekit/livekit.yaml); em qualquer outro ambiente informe o seu.
export LK_API_SECRET="${LK_API_SECRET:-devsecret-devsecret-devsecret-32}"
ROOM="${ROOM:-bench-$(date +%s)}"
DURATION="${DURATION:-1m}"
AUDIO_PUBLISHERS="${AUDIO_PUBLISHERS:-5}"
VIDEO_PUBLISHERS="${VIDEO_PUBLISHERS:-0}"
SUBSCRIBERS="${SUBSCRIBERS:-10}"
VIDEO_RESOLUTION="${VIDEO_RESOLUTION:-low}"
NUM_PER_SECOND="${NUM_PER_SECOND:-1}"
LAYOUT="${LAYOUT:-speaker}"
LK_CLI_IMAGE="${LK_CLI_IMAGE:-livekit/livekit-cli:latest}"
NETWORK="${NETWORK:-host}"
STATS_OUT="${STATS_OUT:-/tmp/livekit-stats-$(date +%s).csv}"

case "$LK_URL" in
  *dottadigital.com*)
    if [ "${I_KNOW_THIS_IS_PRODUCTION:-}" != "yes" ]; then
      echo "recusado: $LK_URL parece produção. Combine a carga (SPEC, Fase B) e rode com I_KNOW_THIS_IS_PRODUCTION=yes." >&2
      exit 2
    fi
    ;;
esac

sampler_pid=""
if [ -n "${SERVER_CONTAINER:-}" ]; then
  echo "timestamp,cpu_percent,mem_usage,net_io" >"$STATS_OUT"
  (
    while true; do
      docker stats --no-stream --format '{{.CPUPerc}},{{.MemUsage}},{{.NetIO}}' "$SERVER_CONTAINER" 2>/dev/null |
        sed "s/^/$(date +%s),/" >>"$STATS_OUT" || true
      sleep 2
    done
  ) &
  sampler_pid=$!
  trap 'kill "$sampler_pid" 2>/dev/null || true' EXIT
fi

echo "lk load-test: sala=$ROOM url=$LK_URL áudio=$AUDIO_PUBLISHERS vídeo=$VIDEO_PUBLISHERS assinantes=$SUBSCRIBERS duração=$DURATION"
# URL, chave e segredo vão por ambiente (LIVEKIT_*, lidos pelo lk): o segredo não aparece na lista de processos.
extra=()
[ "${NO_SIMULCAST:-}" = 1 ] && extra+=(--no-simulcast)
[ "${SIMULATE_SPEAKERS:-}" = 1 ] && extra+=(--simulate-speakers)
docker run --rm --network "$NETWORK" -e LIVEKIT_URL="$LK_URL" -e LIVEKIT_API_KEY="$LK_API_KEY" -e LIVEKIT_API_SECRET \
  "$LK_CLI_IMAGE" load-test \
  --room "$ROOM" --duration "$DURATION" \
  --audio-publishers "$AUDIO_PUBLISHERS" --video-publishers "$VIDEO_PUBLISHERS" --subscribers "$SUBSCRIBERS" \
  --video-resolution "$VIDEO_RESOLUTION" --num-per-second "$NUM_PER_SECOND" --layout "$LAYOUT" ${extra[@]+"${extra[@]}"}

if [ -n "$sampler_pid" ]; then
  echo "amostras de CPU/memória/rede de $SERVER_CONTAINER em $STATS_OUT"
fi
