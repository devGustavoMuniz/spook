// Baseline de Fase 0: mesmo cenário contra Laravel (antrax) e Spook (RNF03).
// Variáveis: BASE_URL (obrigatória), HEALTH_PATH (/healthz), RATE (req/s, 5), DURATION (60s).
// A carga padrão é leve de propósito: o antrax roda em produção.
import { check } from "k6";
import http from "k6/http";

const BASE_URL = __ENV.BASE_URL;
if (!BASE_URL) throw new Error("defina BASE_URL (ex.: https://antrax.dottadigital.com)");
const HEALTH_PATH = __ENV.HEALTH_PATH || "/healthz";

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
  const res = http.get(`${BASE_URL}${HEALTH_PATH}`);
  check(res, { "status 200": (r) => r.status === 200 });
}
