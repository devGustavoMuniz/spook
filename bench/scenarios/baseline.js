// Baseline: mesmo cenário contra Laravel (antrax) e Spook (RNF03).
// Serve às duas medições (ver bench/README.md):
//   - internet ("experiência do usuário"): BASE_URL=https://… passando por Cloudflare e túnel;
//   - interno ("backend"): BASE_URL=http://<serviço> na rede Docker do VPS, sem Cloudflare/túnel.
// Variáveis: BASE_URL (obrigatória), HEALTH_PATH (/healthz), RATE (req/s, 5), DURATION (60s),
//   HOST_HEADER (Host a enviar; use o hostname público ao falar com um proxy interno por virtual host) e
//   FORWARDED_PROTO (ex.: https; envia X-Forwarded-Proto para o app gerar URLs/cookies como na produção).
// A carga padrão é leve de propósito: o antrax também é produção.
import { check } from "k6";
import http from "k6/http";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("defina BASE_URL (ex.: https://antrax.dottadigital.com)");
const HEALTH_PATH = __ENV.HEALTH_PATH || "/healthz";

const headers = {};
if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) headers["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

export const options = {
  scenarios: {
    constant: {
      executor: "constant-arrival-rate",
      rate: Number(__ENV.RATE || 5),
      timeUnit: "1s",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 5,
      maxVUs: 20,
    },
  },
  thresholds: { http_req_failed: ["rate<0.01"] },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export default function () {
  const res = http.get(`${BASE_URL}${HEALTH_PATH}`, { headers });
  recordServerTiming(res);
  check(res, { "status 200": (r) => r.status === 200 });
}
