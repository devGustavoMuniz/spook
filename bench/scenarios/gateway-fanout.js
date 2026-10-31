// Gateway do Spook (Fase 4): fan-out com N usuários conectados. N conexões WebSocket autenticadas, todas no MESMO
// canal, e poucos remetentes a taxa fixa. Mede mensagens entregues por segundo (`gw_received`, taxa no resumo) e
// perdas (`gw_expected` - `gw_received`), mais a latência ponta a ponta (`gw_e2e_latency_ms`). É o insumo do critério
// "CPU e mensagens/s com N usuários conectados" (RNF01): rode junto do `docker-stats.sh` (README, seção 6) durante o
// `HOLD` para ter a CPU do backend no mesmo intervalo.
//
// Cada mensagem enviada deve chegar a todos os RECEIVERS sockets: esperado = enviadas x RECEIVERS. Perda = esperado -
// recebido (mensagem descartada pelo consumidor lento, 4008, ou socket que caiu: `gw_unexpected_close`).
//
// Variáveis: BASE_URL e CHANNEL_ID (obrigatórias); MULTI_COOKIES (cookies das contas de teste que RECEBEM, separados por
//   "|"; o servidor aceita até 20 sessões por usuário, então use pelo menos RECEIVERS/20 contas); SENDER_COOKIES (cookies de quem
//   ENVIA, separados por "|"; padrão: o primeiro de MULTI_COOKIES). Todos precisam ser membros do canal (VIEW_CHANNEL +
//   SEND_MESSAGES). RECEIVERS (100), RAMP (30s, conexões abertas ao longo desse tempo: o handshake é limitado a 50/s por IP),
//   DURATION (60s, o tempo de envio), SEND_RATE (mensagens/s no total, o menor entre 2 e o máximo dos remetentes; máximo 0,8 por remetente, que é o rate limit de
//   5 mensagens a cada 5 s por usuário e canal), TICKET=1, HOST_HEADER.
// ATENÇÃO: ESCREVE mensagens no canal. Use um servidor/canal de teste e contas descartáveis. NÃO execute contra produção
// sem combinar a carga (Fase B).
import { check, sleep } from "k6";
import exec from "k6/execution";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import { frame, gatewayRequest, OP } from "./lib/gateway.js";

const BASE_URL = __ENV.BASE_URL;
const CHANNEL_ID = __ENV.CHANNEL_ID;
if (!BASE_URL || !CHANNEL_ID || !__ENV.MULTI_COOKIES) {
  throw new Error("defina BASE_URL, CHANNEL_ID e MULTI_COOKIES (cookies das contas de teste)");
}
const RECEIVER_COOKIES = __ENV.MULTI_COOKIES.split("|").filter(Boolean);
const SENDER_COOKIES = (__ENV.SENDER_COOKIES || RECEIVER_COOKIES[0]).split("|").filter(Boolean);
const RECEIVERS = Number(__ENV.RECEIVERS || 100);
const MAX_PER_SENDER = 0.8;
const SEND_RATE = Number(__ENV.SEND_RATE || Math.min(2, MAX_PER_SENDER * SENDER_COOKIES.length));
const USE_TICKET = __ENV.TICKET === "1";

function seconds(s) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s);
  if (!m) throw new Error(`duração inválida: ${s}`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
}
const RAMP_S = seconds(__ENV.RAMP || "30s");
const DURATION_S = seconds(__ENV.DURATION || "60s");
const WARMUP_S = 5; // o envio começa depois que todos os sockets abriram
const SEND_START_S = RAMP_S + WARMUP_S;
const END_S = SEND_START_S + DURATION_S + 5; // folga para as últimas entregas

if (RECEIVER_COOKIES.length * 20 < RECEIVERS) {
  throw new Error(
    `RECEIVERS=${RECEIVERS} exige ao menos ${Math.ceil(RECEIVERS / 20)} contas em MULTI_COOKIES (20 sessões por usuário)`,
  );
}
if (SEND_RATE > MAX_PER_SENDER * SENDER_COOKIES.length) {
  throw new Error(
    `SEND_RATE=${SEND_RATE}/s excede o limite de ${MAX_PER_SENDER}/s por remetente (${SENDER_COOKIES.length} remetente(s)): acrescente cookies em SENDER_COOKIES`,
  );
}

const e2e = new Trend("gw_e2e_latency_ms", true);
const received = new Counter("gw_received"); // entregas (uma por mensagem e por socket)
const expected = new Counter("gw_expected"); // enviadas com sucesso x RECEIVERS
const sent = new Counter("gw_sent");
const rateLimited = new Counter("send_rate_limited");
const connectFailed = new Counter("gw_connect_failed");
const unexpectedClose = new Counter("gw_unexpected_close");

export const options = {
  scenarios: {
    receivers: {
      executor: "per-vu-iterations",
      exec: "receiver",
      vus: RECEIVERS,
      iterations: 1,
      maxDuration: `${Math.ceil(END_S + 30)}s`,
    },
    senders: {
      executor: "constant-arrival-rate",
      exec: "sender",
      // timeUnit de 10 s permite taxas fracionadas com execuções inteiras.
      rate: Math.max(1, Math.round(SEND_RATE * 10)),
      timeUnit: "10s",
      duration: `${Math.ceil(DURATION_S)}s`,
      startTime: `${Math.ceil(SEND_START_S)}s`,
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    gw_unexpected_close: ["count<1"],
    gw_connect_failed: ["count<1"],
    "http_req_failed{name:send}": ["rate<0.01"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function receiver() {
  const idx = exec.vu.idInTest - 1;
  sleep((idx / RECEIVERS) * RAMP_S); // abre os sockets ao longo da rampa
  const cookie = RECEIVER_COOKIES[idx % RECEIVER_COOKIES.length];
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
    const remainingMs = Math.max(
      1000,
      (END_S - exec.instance.currentTestRunDuration / 1000) * 1000,
    );
    socket.setTimeout(() => {
      closedByUs = true;
      socket.close();
    }, remainingMs);
  });
  if (!check(res, { "upgrade 101": (r) => r && r.status === 101 })) connectFailed.add(1);
}

export function sender() {
  const n = exec.scenario.iterationInTest;
  const cookie = SENDER_COOKIES[n % SENDER_COOKIES.length];
  const res = http.post(
    `${BASE_URL}/api/channels/${CHANNEL_ID}/messages`,
    JSON.stringify({ content: `bench:${Date.now()}:${n}` }),
    {
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        "X-Bench": "spook-fase-4",
        ...(__ENV.HOST_HEADER ? { Host: __ENV.HOST_HEADER } : {}),
      },
      tags: { name: "send" },
      responseCallback: http.expectedStatuses(201, 429),
    },
  );
  if (res.status === 429) {
    rateLimited.add(1);
  } else {
    sent.add(1);
    expected.add(RECEIVERS);
  }
}

// Resumo: entregas/s e perdas, além do que o k6 já imprime.
export function handleSummary(data) {
  const v = (name, key) => data.metrics[name]?.values[key] || 0;
  const recv = v("gw_received", "count");
  const exp = v("gw_expected", "count");
  const lost = Math.max(0, exp - recv);
  const lines = [
    "",
    "== gateway-fanout (Fase 4) ==",
    `receptores: ${RECEIVERS}   remetentes: ${SENDER_COOKIES.length}   taxa de envio: ${SEND_RATE}/s`,
    `mensagens enviadas: ${v("gw_sent", "count")}   (429: ${v("send_rate_limited", "count")})`,
    `entregas esperadas: ${exp}   recebidas: ${recv}   perdidas: ${lost} (${exp ? ((lost / exp) * 100).toFixed(3) : "0"}%)`,
    `entregas por segundo (média do teste): ${v("gw_received", "rate").toFixed(1)}`,
    `latência ponta a ponta p95: ${v("gw_e2e_latency_ms", "p(95)").toFixed(1)} ms`,
    "",
  ];
  return { stdout: `${lines.join("\n")}\n` };
}
