import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildManifest,
  compareVersions,
  isUpdateAvailable,
  PLATFORMS,
} from "./make-latest-json.mjs";

const files = (names) => (name) => (name in names ? names[name] : null);
const all = () => {
  const f = {};
  for (const { suffix } of PLATFORMS) {
    f[`Spook-1.2.0-${suffix}`] = "";
    f[`Spook-1.2.0-${suffix}.sig`] = `assinatura-${suffix}\n`;
  }
  return f;
};
const base = {
  version: "1.2.0",
  tag: "desktop-v1.2.0",
  repo: "devGustavoMuniz/spook",
  notes: "Novidades",
  pubDate: "2026-11-02T12:00:00.000Z",
};

test("monta o manifesto com as quatro plataformas", () => {
  const { manifest, missing } = buildManifest({ ...base, read: files(all()) });
  assert.deepEqual(Object.keys(manifest.platforms), [
    "windows-x86_64",
    "darwin-aarch64",
    "darwin-x86_64",
    "linux-x86_64",
  ]);
  assert.deepEqual(missing, []);
  assert.equal(manifest.version, "1.2.0");
  assert.equal(manifest.notes, "Novidades");
  assert.equal(manifest.pub_date, "2026-11-02T12:00:00.000Z");
  assert.deepEqual(manifest.platforms["darwin-aarch64"], {
    signature: "assinatura-macos-arm64.app.tar.gz",
    url: "https://github.com/devGustavoMuniz/spook/releases/download/desktop-v1.2.0/Spook-1.2.0-macos-arm64.app.tar.gz",
  });
});

test("plataforma sem artefato ou sem .sig fica de fora (macOS Intel é experimental)", () => {
  const f = all();
  delete f["Spook-1.2.0-macos-x64.app.tar.gz"];
  delete f["Spook-1.2.0-linux-x64.AppImage.sig"];
  const { manifest, missing } = buildManifest({ ...base, read: files(f) });
  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64", "darwin-aarch64"]);
  assert.deepEqual(missing, ["darwin-x86_64", "linux-x86_64"]);
});

test("assinatura vazia conta como ausente", () => {
  const f = all();
  f["Spook-1.2.0-windows-x64.exe.sig"] = "  \n";
  assert.deepEqual(buildManifest({ ...base, read: files(f) }).missing, ["windows-x86_64"]);
});

test("sem nenhum artefato assinado falha", () => {
  assert.throws(() => buildManifest({ ...base, read: files({}) }), /nenhum artefato assinado/);
});

test("valida versão, tag e repositório", () => {
  const read = files(all());
  assert.throws(() => buildManifest({ ...base, version: "1.2", read }), /versão inválida/);
  assert.throws(() => buildManifest({ ...base, tag: "desktop-v9.9.9", read }), /não bate/);
  assert.throws(() => buildManifest({ ...base, repo: "x y", read }), /repositório inválido/);
});

test("compara versões como o updater (só oferece se a do manifesto for maior)", () => {
  assert.ok(compareVersions("1.10.0", "1.9.9") > 0);
  assert.ok(compareVersions("1.0.0", "1.0.0-beta.1") > 0);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
  assert.ok(isUpdateAvailable("0.1.0", "0.1.1"));
  assert.ok(!isUpdateAvailable("0.2.0", "0.2.0"));
  assert.ok(!isUpdateAvailable("0.3.0", "0.2.9"));
});
