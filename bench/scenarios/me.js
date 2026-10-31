// Endpoint autenticado e leve, comparável nos dois sistemas: "GET do usuário logado", sem efeitos colaterais.
//   Spook : GET /api/users/me          (JSON)
//   antrax: GET /settings/profile      (página Inertia; o usuário vem em props.auth.user). Em ME_STYLE=inertia o
//           k6 faz a requisição XHR do Inertia (X-Inertia: true), que devolve JSON em vez do HTML da página.
// Não cadastra nem faz login: recebe o cookie de sessão de um login que VOCÊ fez no navegador.
//
// Variáveis: BASE_URL e COOKIE (obrigatórias), ME_PATH (/api/users/me), ME_STYLE (json | inertia),
//   RATE (req/s, 5), DURATION (60s), HOST_HEADER, FORWARDED_PROTO (ver baseline.js) e
//   INERTIA_VERSION (opcional; se faltar, o setup descobre a versão lendo a página).
// COOKIE é o valor inteiro do header Cookie, copiado do navegador (DevTools):
//   Spook : spook_session=<token>               (Application > Cookies; o cookie é HttpOnly)
//   antrax: laravel_session=<…>; XSRF-TOKEN=<…> (Network > a requisição de uma página > Request Headers > Cookie)
// Passe-o por ambiente (-e COOKIE, sem valor, herdando do shell), nunca na linha de comando, e use um login descartável.
//
// Só as requisições medidas levam a tag name=me; o setup (uma leitura para validar o cookie) fica de fora das métricas
// `{name:me}`, que são as que o summarize.mjs usa.
import { check } from "k6";
import http from "k6/http";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIE = __ENV.COOKIE;
if (!BASE_URL || !COOKIE) {
  throw new Error("defina BASE_URL e COOKIE (header Cookie de uma sessão iniciada no navegador)");
}
const ME_PATH = __ENV.ME_PATH || "/api/users/me";
const STYLE = __ENV.ME_STYLE || "json";
const URL = `${BASE_URL}${ME_PATH}`;

const base = { Cookie: COOKIE, "X-Bench": "spook-fase-1" };
if (__ENV.HOST_HEADER) base.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) base["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

export const options = {
  scenarios: {
    me: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 5),
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  // Os limiares com tag fazem o k6 exportar as métricas só das requisições medidas.
  thresholds: {
    "http_req_failed{name:me}": ["rate<0.01"],
    "http_req_duration{name:me}": ["max>=0"],
    "http_reqs{name:me}": ["count>=0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  const page = http.get(URL, {
    headers: { ...base, Accept: STYLE === "inertia" ? "text/html" : "application/json" },
    redirects: 0,
    tags: { name: "setup" },
  });
  if (page.status === 0) {
    throw new Error(
      `sem resposta de ${URL}: ${page.error || "alvo inalcançável"} (rede/URL/Host corretos?)`,
    );
  }
  if (page.status !== 200) {
    throw new Error(
      `cookie inválido ou expirado: GET ${ME_PATH} deu ${page.status}${page.status === 302 ? " (redireciona ao login)" : ""}`,
    );
  }
  if (STYLE !== "inertia") return { version: "" };
  let version = __ENV.INERTIA_VERSION;
  if (version === undefined) {
    const m =
      /&quot;version&quot;:&quot;([^&]*)&quot;/.exec(page.body) ||
      /"version":\s*"([^"]*)"/.exec(page.body);
    version = m ? m[1] : "";
  }
  return { version };
}

function hasUser(res) {
  if (res.status !== 200) return false;
  if (STYLE !== "inertia") return res.body.includes('"username"');
  try {
    return !!res.json("props.auth.user");
  } catch (_) {
    return false;
  }
}

export default function (data) {
  const headers = { ...base, Accept: "application/json" };
  if (STYLE === "inertia") {
    headers["X-Inertia"] = "true";
    headers["X-Inertia-Version"] = data.version;
    headers["X-Requested-With"] = "XMLHttpRequest";
  }
  const res = http.get(URL, { headers, redirects: 0, tags: { name: "me" } });
  recordServerTiming(res);
  check(res, { "200 com o usuário autenticado": hasUser });
}
