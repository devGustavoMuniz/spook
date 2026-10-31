// Login do antrax (Laravel + Fortify), equivalente ao login.js do Spook: mede só o POST /login.
//
// Como o login do antrax funciona (lido do código do app):
//   - bcrypt, custo 12 (BCRYPT_ROUNDS=12; config/hashing.php padrão do Laravel). Veja o custo em bench/README.md.
//   - Fortify::authenticateUsing envolve a checagem num Timebox de 200 ms: a resposta do login NUNCA demora menos
//     de ~200 ms (é um piso proposital contra enumeração de contas). Se o hash passar disso, vale o hash.
//   - O limite é de 5 tentativas/min por e-mail+IP: por isso o padrão é 4/min.
//   - É preciso um cookie de sessão + XSRF-TOKEN (GET /login primeiro) e o header X-XSRF-TOKEN no POST.
//
// Usa uma conta de teste EXISTENTE e SEM 2FA (não cadastra nada em produção). Credenciais por ambiente:
//   LOGIN_EMAIL, LOGIN_PASSWORD (a senha não vai na linha de comando; veja bench/scripts/run-internal.sh).
//
// Variáveis: BASE_URL e LOGIN_EMAIL/LOGIN_PASSWORD (obrigatórias), LOGIN_PATH (/login), RATE_PER_MIN (4), DURATION (6m),
//   HOST_HEADER, FORWARDED_PROTO (ver baseline.js) e PUBLIC_ORIGIN (Origin/Referer enviados; padrão = BASE_URL).
// Os cookies são tratados à mão (e não pelo cookie jar do k6) porque o app marca-os como Secure e, na medição interna
// por http://, o jar do k6 não os reenviaria.
import { check } from "k6";
import http from "k6/http";
import { Trend } from "k6/metrics";

const BASE_URL = __ENV.BASE_URL;
const EMAIL = __ENV.LOGIN_EMAIL;
const PASSWORD = __ENV.LOGIN_PASSWORD;
if (!BASE_URL || !EMAIL || !PASSWORD) {
  throw new Error(
    "defina BASE_URL, LOGIN_EMAIL e LOGIN_PASSWORD (conta de teste existente, sem 2FA)",
  );
}
const LOGIN_PATH = __ENV.LOGIN_PATH || "/login";
const ORIGIN = __ENV.PUBLIC_ORIGIN || BASE_URL;

const loginDuration = new Trend("login_duration", true);
const base = { Origin: ORIGIN, Referer: `${ORIGIN}${LOGIN_PATH}`, "X-Bench": "spook-fase-1" };
if (__ENV.HOST_HEADER) base.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) base["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

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
  thresholds: { http_req_failed: ["rate<0.01"] },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// Junta os Set-Cookie de uma resposta em um mapa nome -> valor (como veio, ainda codificado).
function collect(jar, res) {
  for (const name of Object.keys(res.cookies)) {
    const list = res.cookies[name];
    jar[name] = list[list.length - 1].value;
  }
}
const cookieHeader = (jar) =>
  Object.keys(jar)
    .map((k) => `${k}=${jar[k]}`)
    .join("; ");

export default function () {
  const jar = {};

  // 1) página de login: devolve o cookie de sessão e o XSRF-TOKEN
  const page = http.get(`${BASE_URL}${LOGIN_PATH}`, {
    headers: { ...base, Accept: "text/html" },
    redirects: 0,
  });
  collect(jar, page);
  const xsrf = jar["XSRF-TOKEN"] ? decodeURIComponent(jar["XSRF-TOKEN"]) : "";
  check(page, { "GET /login 200 com XSRF-TOKEN": (r) => r.status === 200 && xsrf !== "" });
  if (!xsrf) return;

  // 2) o login (é este que se mede)
  const res = http.post(
    `${BASE_URL}${LOGIN_PATH}`,
    JSON.stringify({ email: EMAIL, password: PASSWORD, remember: false }),
    {
      headers: {
        ...base,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-XSRF-TOKEN": xsrf,
        Cookie: cookieHeader(jar),
      },
      redirects: 0,
    },
  );
  loginDuration.add(res.timings.duration);
  check(res, {
    "login ok (200/204, ou 302 que não volta para o login)": (r) =>
      r.status === 200 ||
      r.status === 204 ||
      (r.status === 302 && !String(r.headers.Location || "").includes(LOGIN_PATH)),
  });
}
