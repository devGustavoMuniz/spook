#!/usr/bin/env node
// Agrega os summaries do k6 (--summary-export) gerados por run-alternating.sh e imprime tabelas em Markdown:
// uma linha por rodada e a MEDIANA entre as rodadas de cada estatística (p50/p95/p99 etc.).
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

const groups = {};
for (const f of readdirSync(dir)
  .filter((f) => /-r\d+\.json$/.test(f))
  .sort()) {
  const name = f.replace(/-r\d+\.json$/, "");
  const m = JSON.parse(readFileSync(join(dir, f), "utf8")).metrics;
  // login.js mede a latência do login em login_duration; os demais em http_req_duration.
  const d = m.login_duration ?? m.http_req_duration;
  const reqs = m.http_reqs;
  const failed = m.http_req_failed;
  if (!groups[name]) groups[name] = [];
  groups[name].push({
    run: f.match(/-r(\d+)\.json$/)[1],
    avg: d.avg,
    med: d.med,
    p90: d["p(90)"],
    p95: d["p(95)"],
    p99: d["p(99)"],
    max: d.max,
    reqs: reqs.count,
    rate: reqs.rate,
    failPct: (failed.value ?? 0) * 100,
    fails: failed.passes ?? 0,
  });
}

for (const [name, runs] of Object.entries(groups)) {
  console.log(`\n### ${name} (${runs.length} rodadas)\n`);
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
}
