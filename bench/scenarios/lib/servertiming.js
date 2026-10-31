// Lê o header Server-Timing do Spook (app;dur=…, db;dur=…, argon2;dur=…) e registra as durações como métricas do k6.
// Respostas sem o header (antrax) são ignoradas, então o mesmo código serve aos dois sistemas.
import { Trend } from "k6/metrics";

const app = new Trend("server_timing_app", true); // tempo de processamento da requisição no backend
const db = new Trend("server_timing_db", true); // parte gasta no banco (soma das consultas da requisição)
const argon2 = new Trend("server_timing_argon2", true); // parte gasta no hash de senha (login/cadastro)

export function recordServerTiming(res) {
  const h = res.headers["Server-Timing"];
  if (!h) return;
  const a = /(?:^|,\s*)app;dur=([\d.]+)/.exec(h);
  if (a) app.add(Number(a[1]));
  const d = /(?:^|,\s*)db;dur=([\d.]+)/.exec(h);
  if (d) db.add(Number(d[1]));
  const g = /(?:^|,\s*)argon2;dur=([\d.]+)/.exec(h);
  if (g) argon2.add(Number(g[1]));
}
