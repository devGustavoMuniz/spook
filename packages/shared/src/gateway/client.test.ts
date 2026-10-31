import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../http";
import { GatewayClient, type GatewayError, type GatewayOptions, gatewayUrl } from "./client";
import { FakeSocket } from "./test-utils";

const guild = {
  id: "100",
  name: "Spook HQ",
  icon_key: null,
  owner_id: "10",
  created_at: "2026-10-31T12:00:00Z",
  roles: [],
  channels: [],
  permissions: 0,
  is_owner: false,
  my_role_ids: [],
};
const ready = (session = "sess-1") => ({
  session_id: session,
  user: { id: "11" },
  guilds: [guild],
});
const message = (id: string) => ({
  id,
  channel_id: "300",
  author: { id: "10", username: "ana" },
  content: `msg ${id}`,
  edited_at: null,
  created_at: "2026-10-31T12:00:00Z",
});

function setup(extra: Partial<GatewayOptions> = {}) {
  const calls = {
    ready: vi.fn(),
    resumed: vi.fn(),
    invalidated: vi.fn(),
    errors: [] as GatewayError[],
    statuses: [] as string[],
  };
  const client = new GatewayClient({
    url: "ws://x/api/gateway",
    client: "web",
    socketFactory: (url) => new FakeSocket(url),
    random: () => 0, // backoff = metade do teto; primeiro heartbeat em 0 ms
    onReady: calls.ready,
    onResumed: calls.resumed,
    onInvalidated: calls.invalidated,
    onError: (e) => calls.errors.push(e),
    onStatusChange: (s) => calls.statuses.push(s),
    ...extra,
  });
  return { client, calls };
}

/** Conecta e completa o handshake até o READY. */
async function connected(extra: Partial<GatewayOptions> = {}) {
  const ctx = setup(extra);
  ctx.client.connect();
  await vi.advanceTimersByTimeAsync(0);
  const sock = FakeSocket.last;
  sock.hello();
  sock.dispatch("READY", 1, ready());
  return { ...ctx, sock };
}

/** Passa o backoff e devolve o novo socket, já com HELLO. */
async function reconnectedSocket(ms = 60_000) {
  const before = FakeSocket.instances.length;
  for (let t = 0; t < ms && FakeSocket.instances.length === before; t += 100)
    await vi.advanceTimersByTimeAsync(100);
  expect(FakeSocket.instances.length).toBe(before + 1);
  const sock = FakeSocket.last;
  sock.hello();
  return sock;
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.reset();
});
afterEach(() => vi.useRealTimers());

describe("gatewayUrl", () => {
  it("troca o esquema e acrescenta o caminho", () => {
    expect(gatewayUrl("https://spook.dev")).toBe("wss://spook.dev/api/gateway");
    expect(gatewayUrl("http://localhost:5180/")).toBe("ws://localhost:5180/api/gateway");
  });
});

describe("handshake", () => {
  it("HELLO -> IDENTIFY -> READY: conecta e expõe a sessão", async () => {
    const { client, calls, sock } = await connected();
    expect(sock.url).toBe("ws://x/api/gateway");
    expect(sock.ops(2)).toEqual([{ op: 2, t: null, s: null, d: { client: "web" } }]);
    expect(client.status).toBe("connected");
    expect(client.sessionId).toBe("sess-1");
    expect(client.lastSeq).toBe(1);
    expect(calls.ready).toHaveBeenCalledWith(expect.objectContaining({ session_id: "sess-1" }), {
      reconnect: false,
    });
    expect(calls.invalidated).not.toHaveBeenCalled();
    expect(calls.statuses).toEqual(["connecting", "connected"]);
  });

  it("sem HELLO no prazo, derruba e tenta de novo", async () => {
    const { client } = setup({ connectTimeoutMs: 5_000 });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const first = FakeSocket.last;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(first.closedWith?.code).toBeDefined();
    expect(client.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("frame que não é JSON ou payload inválido vira erro de protocolo sem derrubar a conexão", async () => {
    const { client, calls, sock } = await connected();
    const seen = vi.fn();
    client.on("MESSAGE_CREATE", seen);
    sock.receiveRaw("não-é-json");
    sock.dispatch("MESSAGE_CREATE", 2, { id: 1 }); // payload inválido
    sock.dispatch("MESSAGE_CREATE", 3, message("3"));
    expect(calls.errors.map((e) => e.kind)).toEqual(["protocol", "protocol"]);
    expect(seen).toHaveBeenCalledTimes(1);
    expect(client.status).toBe("connected");
  });
});

describe("autenticação por ticket", () => {
  it("pede um ticket novo a cada conexão e o põe na query", async () => {
    let n = 0;
    const getTicket = vi.fn(async () => `t${++n}`);
    const { sock } = await connected({ getTicket });
    expect(sock.url).toBe("ws://x/api/gateway?ticket=t1");
    sock.serverClose(1006);
    await reconnectedSocket();
    expect(FakeSocket.last.url).toBe("ws://x/api/gateway?ticket=t2");
    expect(getTicket).toHaveBeenCalledTimes(2);
  });

  it("401 ao obter o ticket não reconecta: fica fechado com erro de autenticação", async () => {
    const getTicket = vi.fn(async () => {
      throw new ApiError(401, "autenticação necessária");
    });
    const { client, calls } = setup({ getTicket });
    client.connect();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(client.status).toBe("closed");
    expect(calls.errors[0]?.kind).toBe("auth");
    expect(getTicket).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(0);
  });

  it("falha de rede ao obter o ticket tenta de novo com backoff", async () => {
    let calls = 0;
    const getTicket = vi.fn(async () => {
      if (++calls < 3) throw new TypeError("Failed to fetch");
      return "ok";
    });
    const { client } = setup({ getTicket });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(client.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(500); // 1ª espera = 500 ms (random 0)
    expect(getTicket).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_000); // 2ª = 1000 ms
    expect(getTicket).toHaveBeenCalledTimes(3);
    expect(FakeSocket.last.url).toContain("ticket=ok");
  });
});

describe("heartbeat", () => {
  it("manda heartbeat com o último s a cada intervalo e aceita o ack", async () => {
    const { sock } = await connected();
    sock.dispatch("MESSAGE_CREATE", 2, message("2"));
    await vi.advanceTimersByTimeAsync(0); // random() = 0: o primeiro sai já
    expect(sock.ops(1)).toEqual([{ op: 1, t: null, s: null, d: 2 }]);
    sock.ack();
    await vi.advanceTimersByTimeAsync(41_000);
    expect(sock.ops(1)).toHaveLength(2);
    sock.ack();
    await vi.advanceTimersByTimeAsync(41_000);
    expect(sock.ops(1)).toHaveLength(3);
    expect(FakeSocket.instances).toHaveLength(1);
  });

  it("sem ack no prazo, considera a conexão morta e retoma a sessão", async () => {
    const { client, sock } = await connected({ ackTimeoutMs: 10_000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(sock.ops(1)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sock.closedWith).not.toBeNull();
    expect(client.status).toBe("reconnecting");
    const next = await reconnectedSocket();
    expect(next.ops(3)).toEqual([{ op: 3, t: null, s: null, d: { session_id: "sess-1", seq: 1 } }]);
  });

  it("heartbeat enviado antes do primeiro intervalo usa o jitter", async () => {
    const { client } = setup({ random: () => 0.5 });
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const sock = FakeSocket.last;
    sock.hello(40_000);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(sock.ops(1)).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(sock.ops(1)).toHaveLength(1);
  });
});

describe("reconexão e backoff", () => {
  it("espera exponencial com teto e zera depois do READY", async () => {
    const { client, sock } = await connected({
      random: () => 1, // sem desconto: espera = teto
      backoff: { baseMs: 1_000, maxMs: 8_000 },
    });
    sock.serverClose(1006);
    const waits: number[] = [];
    for (let i = 0; i < 5; i++) {
      const count = FakeSocket.instances.length;
      let waited = 0;
      while (FakeSocket.instances.length === count) {
        await vi.advanceTimersByTimeAsync(100);
        waited += 100;
      }
      waits.push(waited);
      FakeSocket.last.serverClose(1006); // nunca chega ao READY
    }
    expect(waits).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);

    // um READY zera o contador
    const last = FakeSocket.last;
    expect(client.status).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(8_000);
    const s2 = FakeSocket.last;
    s2.hello();
    s2.dispatch("READY", 1, ready("sess-2"));
    s2.serverClose(1006);
    const count = FakeSocket.instances.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.instances.length).toBe(count + 1);
    expect(last).not.toBe(s2);
  });

  it("jitter: com random=0 a espera é a metade do teto", async () => {
    const { sock } = await connected({ random: () => 0 });
    sock.serverClose(1006);
    await vi.advanceTimersByTimeAsync(499);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it.each([1001, 4000, 4001, 4003, 4005, 4006, 4008, 4009, 4029, 1006])(
    "fecha com %i: reconecta",
    async (code) => {
      const { client, sock } = await connected();
      sock.serverClose(code);
      expect(client.status).toBe("reconnecting");
      await reconnectedSocket();
      expect(FakeSocket.instances).toHaveLength(2);
    },
  );

  it("4029 espera ao menos 5 s", async () => {
    const { sock } = await connected();
    sock.serverClose(4029);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(FakeSocket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("4002 (sessão retomada em outra conexão) não reconecta", async () => {
    const { client, calls, sock } = await connected();
    sock.serverClose(4002);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(client.status).toBe("closed");
    expect(FakeSocket.instances).toHaveLength(1);
    expect(calls.errors).toContainEqual(
      expect.objectContaining({ kind: "taken_over", code: 4002 }),
    );
  });

  it("reconnectNow pula a espera do backoff", async () => {
    const { client, sock } = await connected({ random: () => 1 });
    sock.serverClose(1006);
    await vi.advanceTimersByTimeAsync(100);
    client.reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("notifyOffline derruba a conexão na hora (sem esperar heartbeat)", async () => {
    const { client, sock } = await connected();
    client.notifyOffline();
    expect(client.status).toBe("reconnecting");
    expect(sock.closedWith).not.toBeNull();
  });

  it("eventos de um socket descartado são ignorados", async () => {
    const { client, sock } = await connected();
    const seen = vi.fn();
    client.on("MESSAGE_CREATE", seen);
    client.notifyOffline();
    sock.dispatch("MESSAGE_CREATE", 2, message("2"));
    sock.serverClose(4002);
    expect(seen).not.toHaveBeenCalled();
    expect(client.status).toBe("reconnecting");
  });
});

describe("resume", () => {
  it("reconecta com session_id e o último s; RESUMED volta a conectado sem invalidar", async () => {
    const { client, calls, sock } = await connected();
    const seen: string[] = [];
    client.onEvent((e) => seen.push(e.t));
    sock.dispatch("MESSAGE_CREATE", 2, message("2"));
    sock.dispatch("MESSAGE_CREATE", 3, message("3"));
    sock.serverClose(1006);
    expect(client.status).toBe("reconnecting");

    const next = await reconnectedSocket();
    expect(next.ops(2)).toHaveLength(0);
    expect(next.ops(3)).toEqual([{ op: 3, t: null, s: null, d: { session_id: "sess-1", seq: 3 } }]);

    // eventos reenviados e depois RESUMED (s = null)
    next.dispatch("MESSAGE_CREATE", 4, message("4"));
    next.dispatch("RESUMED", null, { session_id: "sess-1", replayed: 1 });
    expect(client.status).toBe("connected");
    expect(client.lastSeq).toBe(4);
    expect(calls.resumed).toHaveBeenCalledWith({ session_id: "sess-1", replayed: 1 });
    expect(calls.invalidated).not.toHaveBeenCalled();
    expect(seen).toEqual(["MESSAGE_CREATE", "MESSAGE_CREATE", "MESSAGE_CREATE", "RESUMED"]);
  });

  it("op 9: refaz o IDENTIFY na mesma conexão e avisa onInvalidated no READY", async () => {
    const { client, calls, sock } = await connected();
    sock.serverClose(1006);
    const next = await reconnectedSocket();
    next.receive({ op: 9, d: false });
    expect(client.sessionId).toBeNull();
    expect(next.ops(2)).toEqual([{ op: 2, t: null, s: null, d: { client: "web" } }]);
    expect(FakeSocket.instances).toHaveLength(2); // continua na mesma conexão

    next.dispatch("READY", 1, ready("sess-2"));
    expect(client.sessionId).toBe("sess-2");
    expect(client.status).toBe("connected");
    expect(calls.invalidated).toHaveBeenCalledTimes(1);
    expect(calls.ready).toHaveBeenLastCalledWith(expect.anything(), { reconnect: true });
  });

  it("sem sessão (nunca chegou READY), reconecta com IDENTIFY", async () => {
    const { client } = setup();
    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    FakeSocket.last.serverClose(1006);
    const next = await reconnectedSocket();
    expect(next.ops(3)).toHaveLength(0);
    expect(next.ops(2)).toHaveLength(1);
  });
});

describe("ordem e deduplicação por s", () => {
  it("descarta repetidos e antigos; entrega em ordem", async () => {
    const { client, sock } = await connected();
    const ids: string[] = [];
    client.on("MESSAGE_CREATE", (d) => ids.push(d.id));
    sock.dispatch("MESSAGE_CREATE", 2, message("a"));
    sock.dispatch("MESSAGE_CREATE", 2, message("a-repetido"));
    sock.dispatch("MESSAGE_CREATE", 3, message("b"));
    sock.dispatch("MESSAGE_CREATE", 1, message("antigo"));
    sock.dispatch("MESSAGE_CREATE", 4, message("c"));
    expect(ids).toEqual(["a", "b", "c"]);
    expect(client.lastSeq).toBe(4);
  });

  it("buraco em s entrega o evento e avisa onInvalidated", async () => {
    const { client, calls, sock } = await connected();
    const ids: string[] = [];
    client.on("MESSAGE_CREATE", (d) => ids.push(d.id));
    sock.dispatch("MESSAGE_CREATE", 2, message("a"));
    sock.dispatch("MESSAGE_CREATE", 5, message("b"));
    expect(ids).toEqual(["a", "b"]);
    expect(calls.invalidated).toHaveBeenCalledTimes(1);
  });

  it("evento desconhecido avança a sequência e é ignorado", async () => {
    const { client, calls, sock } = await connected();
    sock.dispatch("EVENTO_NOVO", 2, { x: 1 });
    expect(client.lastSeq).toBe(2);
    expect(calls.errors).toHaveLength(0);
  });

  it("handler que lança não derruba os outros nem a conexão", async () => {
    const { client, calls, sock } = await connected();
    const ok = vi.fn();
    client.on("MESSAGE_CREATE", () => {
      throw new Error("boom");
    });
    client.on("MESSAGE_CREATE", ok);
    sock.dispatch("MESSAGE_CREATE", 2, message("a"));
    expect(ok).toHaveBeenCalled();
    expect(calls.errors).toHaveLength(1);
    expect(client.status).toBe("connected");
  });
});

describe("close", () => {
  it("encerra de vez: fecha o socket, não reconecta e permite uma sessão nova", async () => {
    const { client, sock } = await connected();
    client.close();
    expect(sock.closedWith?.code).toBe(1000);
    expect(client.status).toBe("closed");
    expect(client.sessionId).toBeNull();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);

    client.connect();
    await vi.advanceTimersByTimeAsync(0);
    const next = FakeSocket.last;
    next.hello();
    expect(next.ops(2)).toHaveLength(1); // IDENTIFY, não RESUME
    expect(next.ops(3)).toHaveLength(0);
  });

  it("close durante a espera do backoff cancela a reconexão", async () => {
    const { client, sock } = await connected();
    sock.serverClose(1006);
    client.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
