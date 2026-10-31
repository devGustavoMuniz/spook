// Não lidas do Spook (Fase 6b): o custo da consulta de estados de leitura e do ack.
//   1. GET /api/users/@me/read-states            -> um canal por linha, contagem limitada a 100 (name=read_states)
//   2. PUT /api/channels/{CHANNEL_ID}/ack        -> upsert que nunca regride, zera menções ao alcançar a última (name=ack)
// Não cadastra nem faz login: recebe o cookie de sessão de um login que VOCÊ fez no navegador (mesma convenção do messages.js).
// O ack usa o ID da última mensagem do canal (descoberto no setup), então depois do primeiro ele não muda nada no estado
// (a leitura nunca regride): mede o caminho do upsert, não efeitos acumulados. Escreve só em read_states da conta de teste;
// use uma conta DESCARTÁVEL. Para o GET ficar representativo, a conta deve participar de muitos canais/DMs com mensagens não
// lidas (um servidor de teste com dezenas de canais; o custo é por canal com last_message_id > last_read, com LIMIT 100).
//
// Variáveis: BASE_URL, COOKIE e CHANNEL_ID (obrigatórias; canal de texto ou DM da conta), RATE (GETs/s, 5), ACK_RATE (acks/s, 2),
//   DURATION (60s), HOST_HEADER, FORWARDED_PROTO. COOKIE é o valor inteiro do header Cookie (spook_session=<token>); passe-o
//   por ambiente (-e COOKIE, sem valor), nunca na linha de comando. NÃO execute contra produção sem combinar a carga (Fase B).
//
// Só as requisições medidas levam name=read_states/ack; o setup fica fora das métricas {name:...}.
import { check, fail } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIE = __ENV.COOKIE;
const CHANNEL_ID = __ENV.CHANNEL_ID;
if (!BASE_URL || !COOKIE || !CHANNEL_ID) {
  throw new Error(
    "defina BASE_URL, COOKIE (header Cookie de uma sessão iniciada no navegador) e CHANNEL_ID",
  );
}
const RATE = Number(__ENV.RATE || 5);
const ACK_RATE = Number(__ENV.ACK_RATE || 2);

const headers = {
  Cookie: COOKIE,
  "X-Bench": "spook-fase-6b",
  Accept: "application/json",
  "Content-Type": "application/json",
};
if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) headers["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

const channelsPerResponse = new Trend("read_states_channels"); // quantos canais o GET devolveu
const cappedChannels = new Counter("read_states_capped"); // canais que bateram o teto de 100 não lidas
const ackFailed = new Counter("ack_failed");

export const options = {
  scenarios: {
    read_states: {
      executor: "constant-arrival-rate",
      exec: "readStates",
      rate: RATE,
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 5,
      maxVUs: 30,
    },
    ack: {
      executor: "constant-arrival-rate",
      exec: "ack",
      rate: ACK_RATE,
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    "http_req_duration{name:read_states}": ["max>=0"],
    "http_req_duration{name:ack}": ["max>=0"],
    "http_req_failed{name:read_states}": ["rate<0.01"],
    "http_req_failed{name:ack}": ["rate<0.01"],
    ack_failed: ["count==0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const res = http.get(`${BASE_URL}/api/channels/${CHANNEL_ID}/messages?limit=1`, { headers });
  if (res.status === 401) fail("cookie inválido ou expirado");
  if (res.status !== 200) fail(`não foi possível ler o canal ${CHANNEL_ID}: ${res.status}`);
  const msgs = res.json("messages");
  if (!msgs || msgs.length === 0) fail("o canal precisa ter pelo menos uma mensagem para o ack");
  return { lastMessageId: msgs[0].id };
}

export function readStates() {
  const res = http.get(`${BASE_URL}/api/users/@me/read-states`, {
    headers,
    tags: { name: "read_states" },
  });
  recordServerTiming(res);
  const ok = check(res, { "read-states 200": (r) => r.status === 200 });
  if (!ok) return;
  const body = res.json();
  channelsPerResponse.add(body.read_states.length);
  for (const s of body.read_states) if (s.unread_count >= 100) cappedChannels.add(1);
}

export function ack(data) {
  const res = http.put(
    `${BASE_URL}/api/channels/${CHANNEL_ID}/ack`,
    JSON.stringify({ message_id: data.lastMessageId }),
    { headers, tags: { name: "ack" } },
  );
  recordServerTiming(res);
  if (!check(res, { "ack 200": (r) => r.status === 200 })) ackFailed.add(1);
}
