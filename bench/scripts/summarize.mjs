#!/usr/bin/env node
// Agrega os summaries do k6 (--summary-export) gerados por run-alternating.sh (medição pela internet) e
// run-internal.sh (medição interna, prefixo `internal-`) e imprime tabelas em Markdown: uma linha por rodada e
// a MEDIANA entre as rodadas de cada estatística. Quando o Spook devolve Server-Timing, mostra também o tempo
// de processamento do backend (`app`) e o de hash (`argon2`).
//
// Uso: node bench/scripts/summarize.mjs <diretório-com-os-json>
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("uso: summarize.mjs <diretório-com-os-json>");
  process.exit(1);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ms = (v) => `${v.toFixed(1)} ms`;
const trend = (t) => ({
  avg: t.avg,
  med: t.med,
  p90: t["p(90)"],
  p95: t["p(95)"],
  p99: t["p(99)"],
  max: t.max,
});

const groups = {};
for (const f of readdirSync(dir)
  .filter((f) => /-r\d+\.json$/.test(f))
  .sort()) {
  const name = f.replace(/-r\d+\.json$/, "");
  const m = JSON.parse(readFileSync(join(dir, f), "utf8")).metrics;
  // login-*.js medem a latência do login em login_duration; os demais em http_req_duration.
  const d = m.login_duration ?? m.http_req_duration;
  const failed = m.http_req_failed;
  if (!groups[name]) groups[name] = [];
  groups[name].push({
    run: f.match(/-r(\d+)\.json$/)[1],
    ...trend(d),
    reqs: m.http_reqs.count,
    rate: m.http_reqs.rate,
    failPct: (failed.value ?? 0) * 100,
    fails: failed.passes ?? 0,
    app: m.server_timing_app ? trend(m.server_timing_app) : null,
    argon2: m.server_timing_argon2 ? trend(m.server_timing_argon2) : null,
  });
}

const label = (name) =>
  name.startsWith("internal-")
    ? `Interno (backend, sem Cloudflare/túnel): ${name.slice(9)}`
    : `Internet (experiência do usuário): ${name}`;

for (const [name, runs] of Object.entries(groups)) {
  console.log(`\n### ${label(name)} (${runs.length} rodadas)\n`);
  console.log("| Rodada | reqs | req/s | falhas | avg | p50 | p90 | p95 | p99 | max |");
  console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of runs) {
    console.log(
      `| ${r.run} | ${r.reqs} | ${r.rate.toFixed(2)} | ${r.failPct.toFixed(2)}% (${r.fails}) | ${ms(r.avg)} | ${ms(r.med)} | ${ms(r.p90)} | ${ms(r.p95)} | ${ms(r.p99)} | ${ms(r.max)} |`,
    );
  }
  const med = (k) => median(runs.map((r) => r[k]));
  console.log(
    `| **mediana** | ${med("reqs")} | ${med("rate").toFixed(2)} | ${med("failPct").toFixed(2)}% | ${ms(med("avg"))} | ${ms(med("med"))} | ${ms(med("p90"))} | ${ms(med("p95"))} | ${ms(med("p99"))} | ${ms(med("max"))} |`,
  );

  for (const [key, title] of [
    ["app", "Server-Timing `app` (processamento no backend)"],
    ["argon2", "Server-Timing `argon2` (hash de senha)"],
  ]) {
    if (!runs.every((r) => r[key])) continue;
    console.log(
      `\n${title}, mediana entre as rodadas: p50 **${ms(median(runs.map((r) => r[key].med)))}**, p95 ${ms(median(runs.map((r) => r[key].p95)))}, p99 ${ms(median(runs.map((r) => r[key].p99)))}`,
    );
  }
}
