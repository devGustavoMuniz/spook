#!/usr/bin/env node
// Confere o contraste (WCAG 2.x) dos pares de cores de packages/brand/src/tokens.css nos dois temas.
// Texto: mínimo 4.5:1 (AA). Componentes de interface e bolinhas (bordas de campo, anel de foco, status): 3:1.
// Uso: node scripts/contrast.mjs [--md]   (--md imprime a tabela em Markdown para o SPEC 9.2). Sai com 1 se algo falhar.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../packages/brand/src/tokens.css"), "utf8");

function block(selector) {
  const m = css.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`));
  const vars = {};
  for (const [, k, v] of (m?.[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)) vars[k] = v.trim();
  return vars;
}
const light = block(":root");
const dark = { ...light, ...block("\\.dark") };

function resolve(vars, name) {
  let v = vars[name];
  while (v?.startsWith("var(")) v = vars[v.slice(4, -1)];
  return v;
}
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => lin(Number.parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// [rótulo, primeiro plano, fundo(s), mínimo]
const text = 4.5;
const ui = 3;
const surfaces = ["--background", "--surface-1", "--surface-2", "--surface-3"];
const pairs = [
  ["texto principal", "--foreground", surfaces, text],
  ["texto secundário", "--muted-foreground", [...surfaces, "--muted", "--accent"], text],
  ["roxo em texto (links)", "--brand-text", [...surfaces, "--accent"], text],
  ["texto sobre o roxo da marca", "--primary-foreground", ["--primary", "--brand-600"], text],
  ["texto de erro", "--destructive-text", [...surfaces, "--danger-soft"], text],
  ["texto sobre botão destrutivo", "--destructive-foreground", ["--destructive"], text],
  ["texto de sucesso", "--success-text", [...surfaces, "--success-soft"], text],
  ["texto sobre sucesso sólido", "--success-foreground", ["--success"], text],
  ["texto de aviso", "--warning-text", [...surfaces, "--warning-soft"], text],
  ["texto sobre aviso sólido", "--warning-foreground", ["--warning"], text],
  ["texto de info", "--info-text", [...surfaces, "--info-soft"], text],
  ["texto sobre info sólido", "--info-foreground", ["--info"], text],
  ["borda de campo (UI 3:1)", "--input", ["--background", "--surface-2", "--field"], ui],
  ["anel de foco (UI 3:1)", "--ring", surfaces, ui],
  ["anel de quem fala (UI 3:1)", "--speaking", surfaces, ui],
  ["status online", "--online", surfaces, ui],
  ["status ausente", "--idle", surfaces, ui],
  ["status não perturbar", "--dnd", surfaces, ui],
  ["status invisível/offline", "--invisible", surfaces, ui],
];

const md = process.argv.includes("--md");
let failed = 0;
const rows = [];
for (const [label, fg, bgs, min] of pairs) {
  const out = [];
  for (const [theme, vars] of [["claro", light], ["escuro", dark]]) {
    const f = resolve(vars, fg);
    const results = bgs.map((b) => ratio(f, resolve(vars, b)));
    const worst = Math.min(...results);
    if (worst < min) failed++;
    out.push(`${worst.toFixed(1)}${worst >= min ? "" : " FALHA"}`);
  }
  rows.push([label, fg, resolve(light, fg), resolve(dark, fg), out[0], out[1], `${min}:1`]);
}
if (md) {
  console.log("| Par | Token | Claro | Escuro | Pior contraste (claro) | Pior contraste (escuro) | Mínimo |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");
  for (const r of rows) console.log(`| ${r[0]} | \`${r[1]}\` | \`${r[2]}\` | \`${r[3]}\` | ${r[4]} | ${r[5]} | ${r[6]} |`);
} else {
  for (const r of rows) console.log(`${r[0].padEnd(34)} claro ${r[4].padEnd(10)} escuro ${r[5].padEnd(10)} (mín. ${r[6]})`);
}
if (failed) {
  console.error(`${failed} par(es) abaixo do mínimo`);
  process.exit(1);
}
