#!/usr/bin/env node
import { randomBytes } from "node:crypto";
// Servidor falso que imita o contrato HTTP do login Fortify/Laravel (cookies Secure + XSRF, Timebox de 200 ms,
// limite de 5/min), para validar bench/scenarios/login-antrax.js sem tocar em produção.
// Uso: node bench/test/mock-fortify.mjs [porta=8099]   (credenciais: teste@antrax.test / senha-de-teste)
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 8099);
const sessions = new Set();
const hits = new Map();
const parseCookies = (h = "") =>
  Object.fromEntries(
    h
      .split("; ")
      .filter(Boolean)
      .map((c) => c.split(/=(.*)/s).slice(0, 2)),
  );

createServer((req, res) => {
  const send = (code, body, headers = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  if (req.method === "GET" && req.url === "/up") return send(200, { ok: true });
  if (req.method === "GET" && req.url === "/login") {
    const sid = randomBytes(8).toString("hex");
    sessions.add(sid);
    const xsrf = encodeURIComponent(`tok=${randomBytes(8).toString("hex")}`); // codificado, como o Laravel faz
    return send(
      200,
      { page: "login" },
      {
        "set-cookie": [
          `XSRF-TOKEN=${xsrf}; Path=/; Secure; SameSite=Lax`,
          `laravel_session=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        ],
      },
    );
  }
  if (req.method === "POST" && req.url === "/login") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const raw = Buffer.concat(chunks).toString();
      const cookies = parseCookies(req.headers.cookie);
      const xsrfCookie = cookies["XSRF-TOKEN"] && decodeURIComponent(cookies["XSRF-TOKEN"]);
      if (
        !sessions.has(cookies.laravel_session) ||
        !xsrfCookie ||
        req.headers["x-xsrf-token"] !== xsrfCookie
      ) {
        return send(419, { message: "CSRF token mismatch." });
      }
      const key = `${new Date().getMinutes()}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);
      if (hits.get(key) > 5) return send(429, { message: "Too Many Attempts." });
      const { email, password } = JSON.parse(raw || "{}");
      await new Promise((r) => setTimeout(r, 200)); // Timebox
      if (email === "teste@antrax.test" && password === "senha-de-teste")
        return send(200, { two_factor: false });
      return send(422, { message: "These credentials do not match our records." });
    });
    return;
  }
  send(404, {});
}).listen(port, () => console.log(`mock Fortify em :${port}`));
