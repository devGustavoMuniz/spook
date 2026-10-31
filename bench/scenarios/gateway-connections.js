// Gateway do Spook (Fase 3): N conexões WebSocket ociosas, mantidas só com heartbeats.
//   Cada VU abre UMA conexão (cookie ou ticket), faz IDENTIFY, espera o READY e segura a conexão até o fim do cenário,
//   mandando heartbeat no intervalo que o servidor informou no HELLO. Mede o handshake (ws_connecting do k6), o tempo
//   do IDENTIFY até o READY (gw_identify_ms) e quantas conexões caíram sem o cenário pedir (gw_unexpected_close).
// "Conexões por GB de RAM": ver bench/README.md, seção Fase 3 (o k6 gera a carga; a RAM sai do `docker stats` do backend).
//
// Variáveis: BASE_URL e COOKIE (obrigatórias; COOKIE é o header Cookie inteiro, spook_session=<token>, de uma conta de teste);
//   CONNECTIONS (100), RAMP (30s), HOLD (60s), TICKET=1 (autentica por ticket), HOST_HEADER, HEARTBEAT_MS (força o intervalo).
// Todas as conexões usam a MESMA conta (várias sessões do mesmo usuário): o servidor limita a 20 sessões por usuário, então
// para N > 20 use MULTI_COOKIES, uma lista de cookies separados por "|" (contas diferentes), distribuídos entre os VUs.
// O handshake tem limite de IP (padrão 50/s, rajada de 200): RAMP deve deixar CONNECTIONS/RAMP <= 50 conexões/s.
// NÃO rode contra produção sem combinar a carga: 10.000 conexões saturam o VPS de 2 vCPU.
import { check, sleep } from "k6";
import exec from "k6/execution";
import { Counter, Trend } from "k6/metrics";
import ws from "k6/ws";
import { frame, gatewayRequest, OP } from "./lib/gateway.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIES = (__ENV.MULTI_COOKIES || __ENV.COOKIE || "").split("|").filter(Boolean);
if (!BASE_URL || COOKIES.length === 0) {
  throw new Error("defina BASE_URL e COOKIE (ou MULTI_COOKIES=cookie1|cookie2|…)");
}
const CONNECTIONS = Number(__ENV.CONNECTIONS || 100);
const RAMP = __ENV.RAMP || "30s";
const HOLD = __ENV.HOLD || "60s";
const USE_TICKET = __ENV.TICKET === "1";

function seconds(s) {
  const m = /^(\d+)(ms|s|m|h)$/.exec(s);
  if (!m) throw new Error(`duração inválida: ${s}`);
  return Number(m[1]) * { ms: 0.001, s: 1, m: 60, h: 3600 }[m[2]];
}
const TOTAL_MS = (seconds(RAMP) + seconds(HOLD)) * 1000;

const identifyMs = new Trend("gw_identify_ms", true);
const ready = new Counter("gw_ready");
const unexpectedClose = new Counter("gw_unexpected_close");
const heartbeatsAcked = new Counter("gw_heartbeat_ack");

export const options = {
  scenarios: {
    connections: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: RAMP, target: CONNECTIONS },
        { duration: HOLD, target: CONNECTIONS },
      ],
      gracefulRampDown: "0s",
      gracefulStop: "2s",
    },
  },
  thresholds: {
    gw_ready: [`count>=${Math.floor(CONNECTIONS * 0.99)}`],
    gw_unexpected_close: ["count<1"],
    ws_connecting: ["max>=0"],
    gw_identify_ms: ["max>=0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function () {
  const cookie = COOKIES[(exec.vu.idInTest - 1) % COOKIES.length];
  const { url, params } = gatewayRequest(BASE_URL, cookie, USE_TICKET, __ENV.HOST_HEADER);
  // A conexão dura até o fim do cenário (todos os VUs terminam juntos).
  const endAt = exec.scenario.startTime + TOTAL_MS;
  let identifiedAt = 0;
  let closedByUs = false;

  const res = ws.connect(url, params, (socket) => {
    socket.on("message", (data) => {
      const f = JSON.parse(data);
      if (f.op === OP.HELLO) {
        const interval = Number(__ENV.HEARTBEAT_MS || f.d.heartbeat_interval);
        identifiedAt = Date.now();
        socket.send(frame(OP.IDENTIFY, { client: "k6" }));
        socket.setInterval(() => socket.send(frame(OP.HEARTBEAT, null)), interval);
      } else if (f.op === OP.DISPATCH && f.t === "READY") {
        identifyMs.add(Date.now() - identifiedAt);
        ready.add(1);
      } else if (f.op === OP.ACK) {
        heartbeatsAcked.add(1);
      }
    });
    socket.on("close", (code) => {
      if (!closedByUs) {
        unexpectedClose.add(1);
        console.warn(`VU ${exec.vu.idInTest}: conexão caiu (código ${code})`);
      }
    });
    socket.setTimeout(
      () => {
        closedByUs = true;
        socket.close();
      },
      Math.max(1000, endAt - Date.now()),
    );
  });
  check(res, { "upgrade 101": (r) => r && r.status === 101 });
  // Uma conexão por VU: depois que ela acaba (no fim do cenário ou porque caiu) o VU não reconecta; o k6 o interrompe
  // quando o cenário termina (gracefulStop curto, porque a iteração é só este sleep).
  sleep(Math.max(0, (endAt - Date.now()) / 1000) + 30);
}
