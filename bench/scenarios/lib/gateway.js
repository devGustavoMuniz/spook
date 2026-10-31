// Helpers do gateway WebSocket para os cenários k6 da Fase 3 (protocolo: SPEC 5.3).
import http from "k6/http";

export const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  RESUME: 3,
  INVALID: 9,
  HELLO: 10,
  ACK: 11,
};

// BASE_URL http(s)://host -> ws(s)://host/api/gateway. Com TICKET=1 troca o cookie por um ticket de uso único
// (POST /api/gateway/ticket, o caminho do desktop); o ticket consome 1 requisição REST do rate limit de IP.
export function gatewayRequest(baseUrl, cookie, useTicket, hostHeader) {
  const wsBase = baseUrl.replace(/^http/, "ws");
  const headers = { "X-Bench": "spook-fase-3" };
  if (hostHeader) headers.Host = hostHeader;
  if (useTicket) {
    const res = http.post(`${baseUrl}/api/gateway/ticket`, null, {
      headers: { Cookie: cookie, ...(hostHeader ? { Host: hostHeader } : {}) },
      tags: { name: "ticket" },
    });
    if (res.status !== 201) throw new Error(`ticket falhou: ${res.status} ${res.body}`);
    return { url: `${wsBase}/api/gateway?ticket=${res.json("ticket")}`, params: { headers } };
  }
  headers.Cookie = cookie;
  return { url: `${wsBase}/api/gateway`, params: { headers } };
}

export function frame(op, d) {
  return JSON.stringify({ op, t: null, s: null, d: d === undefined ? null : d });
}
