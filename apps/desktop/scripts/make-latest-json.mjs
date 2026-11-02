#!/usr/bin/env node
// Gera o `latest.json` do updater do Tauri a partir dos arquivos que o workflow Desktop junta em `installers/`.
//
// Formato (https://v2.tauri.app/plugin/updater/#static-json-file):
//   { version, notes, pub_date, platforms: { "<so>-<arq>": { signature, url } } }
//
// Cada plataforma só entra se o artefato E a assinatura (`.sig`) existirem: a build do macOS Intel é "experimental"
// (continue-on-error) e pode faltar. Sem nenhuma plataforma o script falha: um manifesto vazio não serve a ninguém.
//
// Uso: node make-latest-json.mjs --dir installers --version 0.2.0 --tag desktop-v0.2.0 --repo dono/repo [--notes "..."] [--out installers/latest.json]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Plataforma do updater -> como o workflow renomeia o artefato atualizável (`Spook-<versão>-<so>-<arq>.<sufixo>`). */
export const PLATFORMS = [
  { key: "windows-x86_64", suffix: "windows-x64.exe" },
  { key: "darwin-aarch64", suffix: "macos-arm64.app.tar.gz" },
  { key: "darwin-x86_64", suffix: "macos-x64.app.tar.gz" },
  { key: "linux-x86_64", suffix: "linux-x64.AppImage" },
];

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compara versões semver (só núcleo `x.y.z`; pré-lançamento vem antes da final). Devolve <0, 0 ou >0. */
export function compareVersions(a, b) {
  const core = (v) => v.split(/[-+]/)[0].split(".").map(Number);
  const [pa, pb] = [core(a), core(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  const [preA, preB] = [a.includes("-"), b.includes("-")];
  if (preA === preB) return 0;
  return preA ? -1 : 1;
}

/** O updater só oferece a atualização quando a versão do manifesto é MAIOR que a instalada. */
export const isUpdateAvailable = (installed, manifestVersion) =>
  compareVersions(manifestVersion, installed) > 0;

/**
 * Monta o manifesto. `read(nome)` devolve o conteúdo do arquivo ou `null` se não existe (injetável para testar).
 * Devolve também as plataformas que ficaram de fora, para o log do workflow.
 */
export function buildManifest({ version, tag, repo, notes = "", pubDate, read }) {
  if (!SEMVER.test(version))
    throw new Error(`versão inválida: "${version}" (esperado semver, ex. 0.2.0)`);
  if (tag !== `desktop-v${version}`)
    throw new Error(`a tag "${tag}" não bate com a versão ${version}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`repositório inválido: "${repo}"`);
  const platforms = {};
  const missing = [];
  for (const { key, suffix } of PLATFORMS) {
    const name = `Spook-${version}-${suffix}`;
    const signature = read(`${name}.sig`)?.trim();
    if (read(name) === null || !signature) {
      missing.push(key);
      continue;
    }
    platforms[key] = {
      signature,
      url: `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(name)}`,
    };
  }
  if (Object.keys(platforms).length === 0) {
    throw new Error(
      "nenhum artefato assinado encontrado (faltam os .sig? o secret TAURI_SIGNING_PRIVATE_KEY está definido?)",
    );
  }
  return {
    manifest: { version, notes, pub_date: pubDate, platforms },
    missing,
  };
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i];
    if (!k?.startsWith("--") || argv[i + 1] === undefined)
      throw new Error(`argumento inválido: ${k}`);
    out[k.slice(2)] = argv[i + 1];
  }
  return out;
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  for (const k of ["dir", "version", "tag", "repo"]) if (!a[k]) throw new Error(`falta --${k}`);
  // O arquivo é lido por inteiro só se existe; o conteúdo do .sig é pequeno (texto base64).
  const read = (name) => {
    const p = join(a.dir, name);
    return existsSync(p)
      ? readFileSync(p, name.endsWith(".sig") ? "utf8" : undefined)?.toString()
      : null;
  };
  const { manifest, missing } = buildManifest({
    version: a.version,
    tag: a.tag,
    repo: a.repo,
    notes: a.notes ?? "",
    pubDate: new Date().toISOString(),
    read: (name) =>
      name.endsWith(".sig") ? read(name) : existsSync(join(a.dir, name)) ? "" : null,
  });
  const out = a.out ?? join(a.dir, "latest.json");
  writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `latest.json: ${Object.keys(manifest.platforms).join(", ")}${missing.length ? ` (sem: ${missing.join(", ")})` : ""}`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`::error::${e.message}`);
    process.exit(1);
  }
}
