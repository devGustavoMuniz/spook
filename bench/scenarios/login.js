// Fase 1: latência do login em produção (RNF01/RNF03). Mede p95 de POST /api/auth/login.
//
// O backend limita /api/auth/* a 10 req/min por IP (burst 10), então a carga é mínima de propósito:
// o padrão é 4 logins/min por 6 min (24 amostras), a mesma taxa do login-antrax.js (o antrax limita a 5/min
// por e-mail+IP). Acima de 10/min você mede 429, não o login. O setup cria UM usuário de teste
// (e-mail @bench.spook.invalid, ver bench/README.md para removê-lo depois).
// Mede também o Server-Timing do backend (server_timing_app e server_timing_argon2): a diferença entre
// login_duration e server_timing_app é o custo de rede (Cloudflare/túnel na medição pela internet).
//
// Uso: k6 run -e BASE_URL=https://spook.dottadigital.com bench/scenarios/login.js
// Variáveis: BASE_URL (obrigatória), RATE_PER_MIN (4), DURATION (6m).
import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("defina BASE_URL (ex.: https://spook.dottadigital.com)");

const loginDuration = new Trend("login_duration", true);
const HEADERS = { "Content-Type": "application/json", "X-Bench": "spook-fase-1" };

export const options = {
  scenarios: {
    login: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE_PER_MIN || 4),
      timeUnit: "1m",
      duration: __ENV.DURATION || "6m",
      preAllocatedVUs: 2,
      maxVUs: 5,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"], // inclui 429: sinal de que a taxa passou do limite
    login_duration: ["p(95)<500"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const id = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const user = {
    email: `bench-${id}@bench.spook.invalid`,
    username: `bench_${id}`.slice(0, 32),
    password: `bench-${id}-senha`,
  };
  const res = http.post(`${BASE_URL}/api/auth/register`, JSON.stringify(user), {
    headers: HEADERS,
  });
  if (res.status !== 201) {
    throw new Error(`cadastro do usuário de teste falhou: ${res.status} ${res.body}`);
  }
  // Registra qual usuário de teste ficou em produção (não há rota de excluir conta). Sem a senha.
  console.log(`usuario_de_teste username=${user.username} email=${user.email}`);
  return user;
}

export default function (user) {
  const res = http.post(
    `${BASE_URL}/api/auth/login`,
    JSON.stringify({ email: user.email, password: user.password }),
    { headers: HEADERS },
  );
  loginDuration.add(res.timings.duration);
  recordServerTiming(res);
  check(res, { "login 200": (r) => r.status === 200 });
}
