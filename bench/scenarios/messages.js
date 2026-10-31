// Mensagens do Spook (Fase 2): histórico paginado por cursor + envio, no caminho quente do chat.
//   history: GET /api/channels/{CHANNEL_ID}/messages?limit=50 e, em seguida, a página anterior (before=<id da última>)
//   send   : POST /api/channels/{CHANNEL_ID}/messages
// Não cadastra nem faz login: recebe o cookie de sessão de um login que VOCÊ fez no navegador (mesma convenção do me.js).
// ATENÇÃO: o envio ESCREVE mensagens no canal. Use um servidor/canal de teste (ver bench/scripts/seed-messages.sql para
// popular um canal com muitas mensagens) e nunca um canal de verdade. Só o Spook tem este cenário (o antrax não é comparado).
//
// Variáveis: BASE_URL, COOKIE e CHANNEL_ID (obrigatórias); HISTORY_RATE (req/s, 5), SEND_RATE (msg/s, 0.8), DURATION (60s),
//   PAGE_SIZE (50), HOST_HEADER, FORWARDED_PROTO.
// O rate limit do servidor é de 5 mensagens a cada 5 s por usuário e canal (SPEC 7.3): SEND_RATE acima de 1/s gera 429
// (contados em `send_rate_limited`, sem falhar o cenário). COOKIE é o valor inteiro do header Cookie (spook_session=<token>);
// passe-o por ambiente (-e COOKIE, sem valor), nunca na linha de comando.
//
// Só as requisições medidas levam name=history ou name=send; o setup fica fora das métricas `{name:...}` usadas pelo summarize.mjs.
import { check } from "k6";
import http from "k6/http";
import { Counter } from "k6/metrics";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIE = __ENV.COOKIE;
const CHANNEL_ID = __ENV.CHANNEL_ID;
if (!BASE_URL || !COOKIE || !CHANNEL_ID) {
  throw new Error("defina BASE_URL, COOKIE (header Cookie de uma sessão iniciada no navegador) e CHANNEL_ID");
}
const PAGE_SIZE = Number(__ENV.PAGE_SIZE || 50);
const URL = `${BASE_URL}/api/channels/${CHANNEL_ID}/messages`;

const headers = { Cookie: COOKIE, "X-Bench": "spook-fase-2", Accept: "application/json" };
if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) headers["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

const rateLimited = new Counter("send_rate_limited");

export const options = {
  scenarios: {
    history: {
      executor: "constant-arrival-rate",
      exec: "history",
      rate: Number(__ENV.HISTORY_RATE || 5),
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
    send: {
      executor: "constant-arrival-rate",
      exec: "send",
      // timeUnit de 10 s permite taxas fracionadas (0,8/s = 8 a cada 10 s) com execuções inteiras.
      rate: Math.round(Number(__ENV.SEND_RATE || 0.8) * 10),
      timeUnit: "10s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    "http_req_failed{name:history}": ["rate<0.01"],
    "http_req_duration{name:history}": ["max>=0"],
    "http_reqs{name:history}": ["count>=0"],
    "http_req_duration{name:send}": ["max>=0"],
    "http_reqs{name:send}": ["count>=0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const res = http.get(`${URL}?limit=1`, { headers, redirects: 0, tags: { name: "setup" } });
  if (res.status === 0) {
    throw new Error(`sem resposta de ${URL}: ${res.error || "alvo inalcançável"} (rede/URL/Host corretos?)`);
  }
  if (res.status === 401) throw new Error("cookie inválido ou expirado: refaça o login no navegador");
  if (res.status !== 200) {
    throw new Error(`GET ${URL} deu ${res.status} (CHANNEL_ID de um canal de texto onde você é membro?): ${res.body}`);
  }
  return {};
}

export function history() {
  const first = http.get(`${URL}?limit=${PAGE_SIZE}`, { headers, redirects: 0, tags: { name: "history" } });
  recordServerTiming(first);
  const ok = check(first, { "histórico 200": (r) => r.status === 200 });
  if (!ok) return;
  // Rolagem infinita: a página anterior, pelo cursor (before = id da mensagem mais antiga recebida).
  const page = first.json();
  if (page.has_more && page.messages.length > 0) {
    const before = page.messages[page.messages.length - 1].id;
    const next = http.get(`${URL}?limit=${PAGE_SIZE}&before=${before}`, { headers, redirects: 0, tags: { name: "history" } });
    recordServerTiming(next);
    check(next, { "página anterior 200": (r) => r.status === 200 });
  }
}

export function send() {
  const res = http.post(URL, JSON.stringify({ content: `bench ${__VU}-${__ITER} ${Date.now()}` }), {
    headers: { ...headers, "Content-Type": "application/json" },
    redirects: 0,
    tags: { name: "send" },
    responseCallback: http.expectedStatuses(201, 429), // 429 é o rate limit esperado, não falha
  });
  recordServerTiming(res);
  if (res.status === 429) {
    rateLimited.add(1);
    return;
  }
  check(res, { "envio 201": (r) => r.status === 201 });
}
