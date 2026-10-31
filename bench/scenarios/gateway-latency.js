// Gateway do Spook (Fase 3): latência ponta a ponta de mensagem (envio por REST -> MESSAGE_CREATE no WebSocket).
//   O VU `sender` envia mensagens por REST com um timestamp no conteúdo ("bench:<epoch ms>:<n>").
//   Os VUs `receivers` mantêm o WebSocket aberto, recebem o MESSAGE_CREATE e registram (agora - timestamp) na Trend
//   `gw_e2e_latency_ms`. Remetente e receptores rodam no MESMO k6 (mesmo relógio), então a latência não sofre de
//   deriva entre máquinas; ela inclui o REST (POST) e o fan-out até o socket. A meta do SPEC é p95 < 100 ms (RNF01).
//
// Variáveis: BASE_URL, COOKIE e CHANNEL_ID (obrigatórias). COOKIE é do remetente e deve ser membro do canal com
//   SEND_MESSAGES. Receptores: MULTI_COOKIES (cookies de contas membros do servidor, separados por "|"); se omitido,
//   todos usam COOKIE (até 20 sessões do mesmo usuário).
//   RECEIVERS (10), SEND_RATE (msg/s, 0.8: o servidor limita 5 msgs a cada 5 s por usuário e canal), DURATION (60s),
//   TICKET=1, HOST_HEADER.
// ATENÇÃO: ESCREVE mensagens no canal. Use um servidor/canal de teste, nunca um de verdade, e nunca contra produção
// sem a Fase B.
import { check } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import { frame, gatewayRequest, OP } from "./lib/gateway.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIE = __ENV.COOKIE;
const CHANNEL_ID = __ENV.CHANNEL_ID;
if (!BASE_URL || !COOKIE || !CHANNEL_ID) {
  throw new Error("defina BASE_URL, COOKIE (do remetente) e CHANNEL_ID");
}
const RECEIVER_COOKIES = (__ENV.MULTI_COOKIES || COOKIE).split("|").filter(Boolean);
const RECEIVERS = Number(__ENV.RECEIVERS || 10);
const SEND_RATE = Number(__ENV.SEND_RATE || 0.8);
const DURATION = __ENV.DURATION || "60s";
const USE_TICKET = __ENV.TICKET === "1";

function seconds(s) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s);
  if (!m) throw new Error(`duração inválida: ${s}`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
}
const DURATION_MS = seconds(DURATION) * 1000;
const WARMUP_MS = 5000; // o remetente começa depois que os receptores abriram o socket

const e2e = new Trend("gw_e2e_latency_ms", true);
const received = new Counter("gw_received");
const sent = new Counter("gw_sent");
const rateLimited = new Counter("send_rate_limited");
const unexpectedClose = new Counter("gw_unexpected_close");

export const options = {
  scenarios: {
    receivers: {
      executor: "per-vu-iterations",
      exec: "receiver",
      vus: RECEIVERS,
      iterations: 1,
      maxDuration: `${Math.ceil((DURATION_MS + WARMUP_MS + 15000) / 1000)}s`,
    },
    sender: {
      executor: "constant-arrival-rate",
      exec: "sender",
      // timeUnit de 10 s permite taxas fracionadas (0,8/s = 8 a cada 10 s) com execuções inteiras.
      rate: Math.max(1, Math.round(SEND_RATE * 10)),
      timeUnit: "10s",
      duration: DURATION,
      startTime: `${WARMUP_MS / 1000}s`,
      preAllocatedVUs: 2,
      maxVUs: 5,
    },
  },
  thresholds: {
    gw_e2e_latency_ms: ["p(95)<100"],
    gw_unexpected_close: ["count<1"],
    "http_req_failed{name:send}": ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function receiver() {
  const cookie = RECEIVER_COOKIES[(exec.vu.idInTest - 1) % RECEIVER_COOKIES.length];
  const { url, params } = gatewayRequest(BASE_URL, cookie, USE_TICKET, __ENV.HOST_HEADER);
  let closedByUs = false;
  const res = ws.connect(url, params, (socket) => {
    socket.on("message", (data) => {
      const f = JSON.parse(data);
      if (f.op === OP.HELLO) {
        socket.send(frame(OP.IDENTIFY, { client: "k6" }));
        socket.setInterval(
          () => socket.send(frame(OP.HEARTBEAT, null)),
          Number(f.d.heartbeat_interval),
        );
      } else if (
        f.op === OP.DISPATCH &&
        f.t === "MESSAGE_CREATE" &&
        f.d.channel_id === CHANNEL_ID
      ) {
        const m = /^bench:(\d+):/.exec(f.d.content);
        if (m) {
          e2e.add(Date.now() - Number(m[1]));
          received.add(1);
        }
      }
    });
    socket.on("close", () => {
      if (!closedByUs) unexpectedClose.add(1);
    });
    socket.setTimeout(
      () => {
        closedByUs = true;
        socket.close();
      },
      DURATION_MS + WARMUP_MS + 5000,
    );
  });
  check(res, { "upgrade 101": (r) => r && r.status === 101 });
}

export function sender() {
  const n = exec.scenario.iterationInTest;
  const res = http.post(
    `${BASE_URL}/api/channels/${CHANNEL_ID}/messages`,
    JSON.stringify({ content: `bench:${Date.now()}:${n}` }),
    {
      headers: {
        Cookie: COOKIE,
        "Content-Type": "application/json",
        "X-Bench": "spook-fase-3",
        ...(__ENV.HOST_HEADER ? { Host: __ENV.HOST_HEADER } : {}),
      },
      tags: { name: "send" },
      responseCallback: http.expectedStatuses(201, 429),
    },
  );
  if (res.status === 429) rateLimited.add(1);
  else sent.add(1);
}
