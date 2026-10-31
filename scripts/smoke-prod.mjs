#!/usr/bin/env node
// Smoke da API pública em produção, incluindo o avatar direto no storage (README do deploy, seção 6.3):
// cadastro → logout → login → URL pré-assinada → preflight CORS → PUT no storage → perfil → GET da imagem.
// Cria UM usuário descartável (smoke-<timestamp>); não existe rota de excluir conta, então ele fica no banco.
//
// Uso: node scripts/smoke-prod.mjs [BASE_URL=https://spook.dottadigital.com]
import { createHash } from "node:crypto";

const base = process.argv[2] ?? "https://spook.dottadigital.com";
const origin = new URL(base).origin;
const stamp = Date.now();
const user = {
  email: `smoke-${stamp}@smoke.spook.invalid`,
  username: `smoke_${stamp}`,
  password: `smoke-${stamp}-senha`,
};
// PNG 1x1 válido (70 bytes)
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const sha = (b) => createHash("sha256").update(b).digest("hex").slice(0, 16);

let cookie = "";
let failures = 0;
const step = (ok, msg, extra = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "OK  " : "FALHA"} ${msg}${extra ? ` — ${extra}` : ""}`);
};

async function api(method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie && { cookie }), ...headers },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const set = res.headers.getSetCookie().find((c) => c.startsWith("spook_session="));
  if (set) cookie = set.split(";")[0].endsWith("=") ? "" : set.split(";")[0];
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { res, json, text, setCookie: set };
}

console.log(`Smoke em ${base} — usuário ${user.username}\n`);

let r = await api("POST", "/api/auth/register", user);
step(r.res.status === 201, "cadastro", `HTTP ${r.res.status}`);
step(
  /HttpOnly/i.test(r.setCookie ?? "") &&
    /Secure/i.test(r.setCookie ?? "") &&
    /SameSite=Lax/i.test(r.setCookie ?? ""),
  "cookie de sessão HttpOnly + Secure + SameSite=Lax",
  r.setCookie?.replace(/=[^;]+/, "=<token>"),
);

r = await api("GET", "/api/users/me");
step(
  r.res.status === 200 && r.json?.username === user.username,
  "perfil logo após o cadastro",
  `HTTP ${r.res.status}`,
);

r = await api("POST", "/api/auth/logout");
step(r.res.status === 204, "logout", `HTTP ${r.res.status}`);
r = await api("GET", "/api/users/me");
step(r.res.status === 401, "perfil sem sessão dá 401", `HTTP ${r.res.status}`);

r = await api("POST", "/api/auth/login", { email: user.email, password: user.password });
step(r.res.status === 200, "login", `HTTP ${r.res.status}`);

r = await api("POST", "/api/users/me/avatar", { content_type: "image/png", size: png.length });
step(
  r.res.status === 200 && r.json?.upload_url,
  "URL pré-assinada do avatar",
  `HTTP ${r.res.status}`,
);
const { upload_url: uploadUrl, key } = r.json ?? {};
if (!uploadUrl) process.exit(1);
console.log(`     host da URL: ${new URL(uploadUrl).host}  chave: ${key}`);

// Preflight CORS que o navegador faria a partir da origem do app
let pre = await fetch(uploadUrl, {
  method: "OPTIONS",
  headers: {
    origin,
    "access-control-request-method": "PUT",
    "access-control-request-headers": "content-type",
  },
});
step(
  pre.status === 200 && pre.headers.get("access-control-allow-origin") === origin,
  `preflight CORS a partir de ${origin}`,
  `HTTP ${pre.status}, Allow-Origin=${pre.headers.get("access-control-allow-origin")}, Allow-Methods=${pre.headers.get("access-control-allow-methods")}`,
);
pre = await fetch(uploadUrl, {
  method: "OPTIONS",
  headers: { origin: "https://evil.example", "access-control-request-method": "PUT" },
});
step(pre.status === 403, "preflight de origem não autorizada é recusado", `HTTP ${pre.status}`);

// PUT direto no storage (como o navegador, com Origin)
const put = await fetch(uploadUrl, {
  method: "PUT",
  headers: { "content-type": "image/png", origin },
  body: png,
});
const putBody = await put.text();
step(put.status === 200, "PUT da imagem direto em spook-files", `HTTP ${put.status}`);
step(
  !/SignatureDoesNotMatch/.test(putBody),
  "sem SignatureDoesNotMatch (Host público chega intacto ao Garage)",
  putBody.slice(0, 120),
);
step(
  put.headers.get("access-control-allow-origin") === origin,
  "resposta do PUT com Allow-Origin da origem do app",
);

r = await api("PATCH", "/api/users/me", { avatar_key: key });
step(
  r.res.status === 200 && r.json?.avatar_url,
  "PATCH do perfil com a chave do avatar",
  `HTTP ${r.res.status}`,
);
r = await api("GET", "/api/users/me");
const avatarUrl = r.json?.avatar_url;
step(
  !!avatarUrl,
  "perfil devolve avatar_url (GET pré-assinado)",
  avatarUrl ? new URL(avatarUrl).host : "",
);

if (avatarUrl) {
  const get = await fetch(avatarUrl, { headers: { origin } });
  const got = Buffer.from(await get.arrayBuffer());
  step(get.status === 200, "GET da imagem pela URL pré-assinada", `HTTP ${get.status}`);
  step(
    got.equals(png),
    "bytes baixados idênticos aos enviados",
    `${got.length} bytes, sha256:${sha(got)} == ${sha(png)}`,
  );
  step(
    get.headers.get("content-type") === "image/png",
    "Content-Type image/png",
    get.headers.get("content-type") ?? "",
  );
}

// recusas de validação do backend em produção
r = await api("POST", "/api/users/me/avatar", { content_type: "text/html", size: 10 });
step(r.res.status === 422, "tipo de arquivo inválido é recusado", `HTTP ${r.res.status}`);
r = await api("PATCH", "/api/users/me", { avatar_key: "avatars/1/qualquer.png" });
step(r.res.status === 422, "chave de avatar de outro usuário é recusada", `HTTP ${r.res.status}`);

r = await api("POST", "/api/auth/logout");
console.log(
  `\n${failures === 0 ? "TUDO OK" : `${failures} FALHA(S)`} — usuário descartável que ficou no banco: ${user.username} (${user.email})`,
);
process.exit(failures === 0 ? 0 : 1);
