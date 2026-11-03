import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..");

// Fora da varredura (justificativa no SPEC 5.5, bloco de internacionalização):
// - i18n/: os próprios catálogos; test/ e *.test.*: fixtures e asserções em pt-BR (idioma dos testes);
// - pages/admin, features/admin, components/charts: ferramenta do dono, só em pt-BR;
// - pages/dev: vitrine do design system (dev).
const SKIP_DIRS = [
  "i18n",
  "test",
  "pages/admin",
  "features/admin",
  "components/charts",
  "pages/dev",
];

/** Exceções por arquivo: trechos que parecem pt-BR mas não são texto de interface. */
const ALLOW: Record<string, RegExp[]> = {
  // Tabela dos textos pt-BR do backend (chaves de lookup para traduzir `detail`), não texto de interface.
  "lib/server-details.ts": [/./],
  // Erros internos de engenharia (logs/diagnóstico), nunca exibidos como estão.
  "features/voice/engine.ts": [/conexão de voz/],
  "features/voice/mic-test.ts": [/sem faixa de áudio/],
  "features/voice/pip.ts": [/vídeo/],
};

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const ACCENT = /[áàâãéêíóôõúçÁÀÂÃÉÊÍÓÔÕÚÇ]/;
const WORDS =
  /\b(Cancelar|Salvar|Fechar|Voltar|Entrar|Sair|Enviar|Excluir|Editar|Carregando|Tentar|Criar|Nenhum|Nenhuma|Você|para o|para a|não foi|Mensagem|Servidor|Canal|Senha|Confirmar|Copiar|Copiado|Procurar|Buscar|Remover|Adicionar|Aberto|Fechado)\b/;

function strip(src: string) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function offenders(file: string): string[] {
  const src = strip(readFileSync(file, "utf8"));
  const found: string[] = [];
  const lines = src.split("\n");
  lines.forEach((line, i) => {
    if (/^\s*(import|export .* from)\b/.test(line)) return;
    if (/console\.(log|warn|error|debug)/.test(line)) return;
    const candidates: string[] = [];
    for (const m of line.matchAll(
      /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g,
    ))
      candidates.push((m[1] ?? m[2] ?? m[3]) as string);
    // texto de JSX: > texto <  ou linha só de texto
    for (const m of line.matchAll(/>([^<>{}]*[A-Za-zÀ-ú][^<>{}]*)</g))
      candidates.push(m[1] as string);
    if (
      /^\s*[A-ZÀ-Ú][^<>{}=;()]*[a-zà-ú.…?!]\s*$/.test(line) &&
      !/^\s*(return|const|let|type|case|default|else)\b/.test(line)
    )
      candidates.push(line.trim());
    for (const c of candidates) {
      if (!(ACCENT.test(c) || WORDS.test(c))) continue;
      if (ALLOW[relative(SRC, file)]?.some((r) => r.test(c))) continue;
      found.push(`${relative(SRC, file)}:${i + 1}: ${c.trim().slice(0, 80)}`);
    }
  });
  return found;
}

describe("sem texto pt-BR literal na interface", () => {
  it("todo texto visível passa por t()", () => {
    const files = walk(SRC).filter((f) => {
      const rel = relative(SRC, f);
      return !SKIP_DIRS.some((d) => rel === d || rel.startsWith(`${d}/`));
    });
    const all = files.flatMap(offenders);
    expect(all).toEqual([]);
  });
});
