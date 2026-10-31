// Emissão de token de voz do Spook (Fase 5): POST /api/channels/{CHANNEL_ID}/voice/token, autenticado por cookie.
// Mede só o backend (autorização do canal + assinatura do JWT do LiveKit); não conecta ao LiveKit nem gera mídia.
// Para CPU/banda por participante use bench/scripts/livekit-load-test.sh.
//
// Variáveis: BASE_URL, COOKIE (header Cookie inteiro de uma sessão iniciada no navegador) e CHANNEL_ID (canal de VOZ
// onde a conta é membro com CONNECT, ou uma DM) são obrigatórias; RATE (req/s, 5), DURATION (60s), HOST_HEADER,
// FORWARDED_PROTO. Passe COOKIE por ambiente (-e COOKIE, sem valor), nunca na linha de comando.
// Efeitos colaterais: cada token vira uma "intenção pendente" de 30 s em memória e, se a conta já estiver em outro canal de
// voz, tira-a de lá. Use um canal e uma conta de TESTE. Sem LIVEKIT_* o servidor responde 503 (o setup avisa).
// O rate limit geral é de 30 req/s por IP (rajada de 90): mantenha RATE abaixo disso.
//
// As requisições medidas levam name=voice_token (o setup fica fora das métricas {name:...}).
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIE = __ENV.COOKIE;
const CHANNEL_ID = __ENV.CHANNEL_ID;
if (!BASE_URL || !COOKIE || !CHANNEL_ID) {
  throw new Error(
    "defina BASE_URL, COOKIE (header Cookie de uma sessão iniciada no navegador) e CHANNEL_ID (canal de voz ou DM)",
  );
}
const URL = `${BASE_URL}/api/channels/${CHANNEL_ID}/voice/token`;

const headers = { Cookie: COOKIE, "X-Bench": "spook-fase-5", Accept: "application/json" };
if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) headers["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

const rateLimited = new Counter("voice_token_rate_limited");
const badToken = new Counter("voice_token_invalid");

export const options = {
  scenarios: {
    token: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 5),
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 5,
      maxVUs: 30,
    },
  },
  thresholds: {
    "http_req_failed{name:voice_token}": ["rate<0.01"],
    "http_req_duration{name:voice_token}": ["max>=0"],
    "http_reqs{name:voice_token}": ["count>=0"],
    voice_token_invalid: ["count==0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

function post(name) {
  return http.post(URL, null, { headers, redirects: 0, tags: { name } });
}

export function setup() {
  const res = post("setup");
  if (res.status === 0) {
    throw new Error(
      `sem resposta de ${URL}: ${res.error || "alvo inalcançável"} (rede/URL/Host corretos?)`,
    );
  }
  if (res.status === 401)
    throw new Error("cookie inválido ou expirado: refaça o login no navegador");
  if (res.status === 503)
    throw new Error(
      "voz desligada no servidor (faltam LIVEKIT_URL, LIVEKIT_API_KEY e LIVEKIT_API_SECRET)",
    );
  if (res.status !== 200) {
    throw new Error(
      `POST ${URL} deu ${res.status} (CHANNEL_ID de um canal de voz com CONNECT, ou de uma DM sua?): ${res.body}`,
    );
  }
}

export default function () {
  const res = post("voice_token");
  recordServerTiming(res);
  if (res.status === 429) rateLimited.add(1);
  const ok = check(res, {
    "status 200": (r) => r.status === 200,
    "token, url e expires_in=600": (r) => {
      if (r.status !== 200) return true;
      const b = r.json();
      return Boolean(b.token) && Boolean(b.url) && b.expires_in === 600;
    },
  });
  if (!ok && res.status === 200) badToken.add(1);
}
