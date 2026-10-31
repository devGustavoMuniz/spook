#!/usr/bin/env node
// Servidor falso com os DOIS contratos do cenário me.js, para validá-lo sem tocar em produção:
//   GET /api/users/me     -> JSON do usuário se o Cookie tiver spook_session=ok (estilo Spook)
//   GET /settings/profile -> com laravel_session=ok: HTML (data-page com a versão) ou, com X-Inertia e a versão
//                            certa, JSON {props:{auth:{user}}}; versão errada = 409; sem sessão = 302 /login (estilo antrax)
// Uso: node bench/test/mock-me.mjs [porta=8098]
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8098);
const VERSION = "v-abc123";
const user = { id: 1, username: "teste", email: "teste@example.test" };

createServer((req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  const cookie = req.headers.cookie ?? "";
  if (req.url === "/api/users/me") {
    return cookie.includes("spook_session=ok")
      ? send(200, user)
      : send(401, { title: "Unauthorized" });
  }
  if (req.url === "/settings/profile") {
    if (!cookie.includes("laravel_session=ok")) return send(302, "", { location: "/login" });
    const page = { component: "settings/profile", props: { auth: { user } }, version: VERSION };
    if (req.headers["x-inertia"]) {
      if (req.headers["x-inertia-version"] !== VERSION)
        return send(409, "", { "x-inertia-location": req.url });
      return send(200, page, { "x-inertia": "true" });
    }
    const html = JSON.stringify(page).replaceAll('"', "&quot;");
    return send(200, `<html><body><div id="app" data-page="${html}"></div></body></html>`, {
      "content-type": "text/html",
    });
  }
  if (req.url === "/up") return send(200, { ok: true });
  send(404, {});
}).listen(port, () => console.log(`mock me em :${port}`));
