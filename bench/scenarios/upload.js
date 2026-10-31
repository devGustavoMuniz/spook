// Uploads do Spook (Fase 6): o fluxo inteiro de um anexo, medindo cada etapa separadamente.
//   1. POST /api/channels/{CHANNEL_ID}/uploads           -> URL pré-assinada de PUT        (name=upload_request)
//   2. PUT  <upload_url> (direto no storage, sem cookie)  -> throughput do envio do arquivo (name=upload_put)
//   3. POST /api/channels/{CHANNEL_ID}/messages {attachment_ids} -> HEAD + conferência de bytes + transação (name=upload_send)
// Não cadastra nem faz login: recebe o cookie de sessão de um login que VOCÊ fez no navegador (mesma convenção do messages.js).
// ATENÇÃO: ESCREVE anexos, mensagens e objetos no storage. Use um servidor/canal e uma conta de TESTE e nunca produção sem
// combinar a carga. Os anexos de teste ficam como mensagens normais do canal (apague o canal depois).
//
// Variáveis: BASE_URL, COOKIE e CHANNEL_ID (obrigatórias; canal de texto ou DM onde a conta tem ATTACH_FILES);
//   KIND (zip | png; padrão zip), FILE_KB (tamanho do arquivo no KIND=zip, 512; máximo 25600), IMG_WIDTH/IMG_HEIGHT (KIND=png,
//   1600x1200 ~ 5,5 MB sem compressão), UPLOADS_PER_MIN (12), DURATION (60s), HOST_HEADER, FORWARDED_PROTO.
// Os arquivos são gerados aqui mesmo (nada a baixar). KIND=png gera um PNG válido (RGB, deflate "stored") para o job de
// thumbnail ter o que decodificar: veja bench/README.md para medir o job pelas métricas e logs do servidor.
// Limites do servidor: 30 pedidos de upload por minuto por usuário (429 em `upload_rate_limited`) e 5 mensagens a cada 5 s por canal
// (429 em `send_rate_limited`); UPLOADS_PER_MIN acima de 30 gera 429 sem falhar o cenário. Cada VU guarda o arquivo na memória:
// com FILE_KB alto, mantenha poucos VUs (o cenário usa no máximo 10). COOKIE é o valor inteiro do header Cookie
// (spook_session=<token>); passe-o por ambiente (-e COOKIE, sem valor), nunca na linha de comando.
//
// Só as requisições medidas levam name=upload_request/upload_put/upload_send; o setup fica fora das métricas {name:...}.
import { check } from "k6";
import http from "k6/http";
import { Counter, Trend } from "k6/metrics";
import { recordServerTiming } from "./lib/servertiming.js";

const BASE_URL = __ENV.BASE_URL;
const COOKIE = __ENV.COOKIE;
const CHANNEL_ID = __ENV.CHANNEL_ID;
if (!BASE_URL || !COOKIE || !CHANNEL_ID) {
  throw new Error(
    "defina BASE_URL, COOKIE (header Cookie de uma sessão iniciada no navegador) e CHANNEL_ID",
  );
}
const KIND = __ENV.KIND || "zip";
if (KIND !== "zip" && KIND !== "png") throw new Error("KIND deve ser zip ou png");
const FILE_KB = Number(__ENV.FILE_KB || 512);
const IMG_WIDTH = Number(__ENV.IMG_WIDTH || 1600);
const IMG_HEIGHT = Number(__ENV.IMG_HEIGHT || 1200);
const PER_MIN = Number(__ENV.UPLOADS_PER_MIN || 12);

const API = `${BASE_URL}/api/channels/${CHANNEL_ID}`;
const headers = {
  Cookie: COOKIE,
  "X-Bench": "spook-fase-6",
  Accept: "application/json",
  "Content-Type": "application/json",
};
if (__ENV.HOST_HEADER) headers.Host = __ENV.HOST_HEADER;
if (__ENV.FORWARDED_PROTO) headers["X-Forwarded-Proto"] = __ENV.FORWARDED_PROTO;

const putMbps = new Trend("upload_put_throughput_mbps"); // MB/s do PUT direto ao storage, por arquivo
const uploadedBytes = new Counter("upload_bytes");
const uploadRateLimited = new Counter("upload_rate_limited");
const sendRateLimited = new Counter("send_rate_limited");
const flowFailed = new Counter("upload_flow_failed"); // fluxos que não chegaram a mensagem com anexo

export const options = {
  scenarios: {
    upload: {
      executor: "constant-arrival-rate",
      // timeUnit de 1 min permite taxas baixas com execuções inteiras.
      rate: PER_MIN,
      timeUnit: "1m",
      duration: __ENV.DURATION || "60s",
      preAllocatedVUs: 2,
      maxVUs: 10,
    },
  },
  thresholds: {
    "http_req_duration{name:upload_request}": ["max>=0"],
    "http_req_duration{name:upload_put}": ["max>=0"],
    "http_req_duration{name:upload_send}": ["max>=0"],
    upload_put_throughput_mbps: ["max>=0"],
    upload_flow_failed: ["count==0"],
  },
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"],
};

// ---- geração dos arquivos ----

// zip: assinatura de arquivo zip (PK\x03\x04) + bytes sem significado. O servidor só confere os primeiros bytes.
function makeZip(kb) {
  const size = Math.max(kb, 1) * 1024;
  const buf = new Uint8Array(size);
  buf.set([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x00, 0x00]);
  for (let i = 10; i < size; i += 7) buf[i] = (i * 31) & 0xff;
  return buf;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(v) {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function chunk(type, data) {
  const t = [type.charCodeAt(0), type.charCodeAt(1), type.charCodeAt(2), type.charCodeAt(3)];
  const td = new Uint8Array(4 + data.length);
  td.set(t);
  td.set(data, 4);
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length));
  out.set(td, 4);
  out.set(u32(crc32(td)), 8 + data.length);
  return out;
}

// png: RGB 8 bits com um gradiente; zlib com blocos "stored" (sem compressão), então o tamanho do arquivo ~ 3*w*h.
function makePNG(w, h) {
  const stride = 1 + w * 3;
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const row = y * stride; // byte de filtro 0 já é zero
    for (let x = 0; x < w; x++) {
      const p = row + 1 + x * 3;
      raw[p] = ((x * 255) / w) & 0xff;
      raw[p + 1] = ((y * 255) / h) & 0xff;
      raw[p + 2] = ((x + y) * 3) & 0xff;
    }
  }
  const blocks = Math.ceil(raw.length / 65535);
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let o = 2;
  for (let i = 0; i < raw.length; i += 65535) {
    const n = Math.min(65535, raw.length - i);
    z[o++] = i + n >= raw.length ? 1 : 0;
    z[o++] = n & 0xff;
    z[o++] = n >> 8;
    z[o++] = ~n & 0xff;
    z[o++] = (~n >> 8) & 0xff;
    z.set(raw.subarray(i, i + n), o);
    o += n;
  }
  z.set(u32(adler32(raw)), o);
  const sig = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunk("IHDR", Uint8Array.from([...u32(w), ...u32(h), 8, 2, 0, 0, 0]));
  const idat = chunk("IDAT", z);
  const iend = chunk("IEND", new Uint8Array(0));
  const png = new Uint8Array(sig.length + ihdr.length + idat.length + iend.length);
  png.set(sig);
  png.set(ihdr, sig.length);
  png.set(idat, sig.length + ihdr.length);
  png.set(iend, sig.length + ihdr.length + idat.length);
  return png;
}

// Um arquivo por VU, gerado na primeira iteração (e não no init, que geraria um por VU possível).
let file = null;
function getFile() {
  if (!file) {
    file =
      KIND === "png"
        ? { bytes: makePNG(IMG_WIDTH, IMG_HEIGHT), name: "bench.png", type: "image/png" }
        : { bytes: makeZip(FILE_KB), name: "bench.zip", type: "application/zip" };
    if (file.bytes.length > 25 * 1024 * 1024) {
      throw new Error(`arquivo de ${file.bytes.length} bytes passa do limite de 25 MB do servidor`);
    }
  }
  return file;
}

function requestUpload(f, name) {
  return http.post(
    `${API}/uploads`,
    JSON.stringify({ filename: f.name, content_type: f.type, size: f.bytes.length }),
    { headers, redirects: 0, tags: { name } },
  );
}

export function setup() {
  const f = getFile();
  const res = requestUpload(f, "setup");
  if (res.status === 0) {
    throw new Error(
      `sem resposta de ${API}: ${res.error || "alvo inalcançável"} (rede/URL/Host corretos?)`,
    );
  }
  if (res.status === 401)
    throw new Error("cookie inválido ou expirado: refaça o login no navegador");
  if (res.status === 503) throw new Error("uploads desligados no servidor (falta o S3_ENDPOINT)");
  if (res.status !== 201) {
    throw new Error(
      `POST ${API}/uploads deu ${res.status} (CHANNEL_ID de um canal de texto/DM com ATTACH_FILES?): ${res.body}`,
    );
  }
}

export default function () {
  const f = getFile();

  const req = requestUpload(f, "upload_request");
  recordServerTiming(req);
  if (req.status === 429) uploadRateLimited.add(1);
  if (!check(req, { "pedido 201": (r) => r.status === 201 })) {
    flowFailed.add(1);
    return;
  }
  const up = req.json();

  // PUT direto no storage: sem cookie, com os cabeçalhos assinados devolvidos pela API.
  const put = http.put(up.upload_url, f.bytes.buffer, {
    headers: up.headers,
    redirects: 0,
    tags: { name: "upload_put" },
  });
  if (!check(put, { "PUT 200": (r) => r.status === 200 })) {
    flowFailed.add(1);
    return;
  }
  uploadedBytes.add(f.bytes.length);
  if (put.timings.duration > 0)
    putMbps.add(f.bytes.length / 1048576 / (put.timings.duration / 1000));

  const send = http.post(
    `${API}/messages`,
    JSON.stringify({ content: "", attachment_ids: [up.id] }),
    {
      headers,
      redirects: 0,
      tags: { name: "upload_send" },
    },
  );
  recordServerTiming(send);
  if (send.status === 429) {
    sendRateLimited.add(1);
    return;
  }
  const ok = check(send, {
    "mensagem 201": (r) => r.status === 201,
    "anexo na mensagem": (r) => r.status !== 201 || r.json("attachments").length === 1,
  });
  if (!ok) flowFailed.add(1);
}
