// Contrato Go <-> TS: todo exemplo de `fixtures/gateway-events.json` (gerado e conferido pelo teste
// Go `TestGatewayEventsFixtures`) precisa passar pelos schemas Zod daqui.
import { describe, expect, it } from "vitest";
import fixtures from "../../fixtures/gateway-events.json";
import {
  ackFrameSchema,
  CloseCode,
  dispatchFrameSchema,
  eventSchemas,
  frameSchema,
  type GatewayEventName,
  heartbeatFrameSchema,
  helloFrameSchema,
  identifyFrameSchema,
  invalidSessionFrameSchema,
  resumeFrameSchema,
  setPresenceFrameSchema,
} from "./schemas";

describe("fixtures do gateway", () => {
  it("frames de controle", () => {
    expect(helloFrameSchema.parse(fixtures.hello).d.heartbeat_interval).toBe(41_000);
    expect(ackFrameSchema.parse(fixtures.ack)).toBeTruthy();
    expect(heartbeatFrameSchema.parse(fixtures.heartbeat).d).toBe(42);
    expect(identifyFrameSchema.parse(fixtures.identify).d.client).toBe("web");
    expect(resumeFrameSchema.parse(fixtures.resume).d).toEqual({
      session_id: "c2Vzc2lvbi1pZA",
      seq: 42,
    });
    expect(invalidSessionFrameSchema.parse(fixtures.invalid_session).d).toBe(false);
  });

  it("READY e RESUMED", () => {
    const ready = dispatchFrameSchema("READY").parse(fixtures.ready);
    expect(ready.s).toBe(1);
    expect(ready.d.guilds[0]?.channels).toHaveLength(3);
    // Fase 4: DMs e presenças vêm no READY (arrays, nunca null)
    expect(Array.isArray(fixtures.ready.d.private_channels)).toBe(true);
    expect(Array.isArray(fixtures.ready.d.presences)).toBe(true);
    const dm = ready.d.private_channels?.[0];
    expect(dm).toMatchObject({ type: 4, guild_id: null, owner_id: "11" });
    expect(dm?.recipients).toHaveLength(3);
    expect(ready.d.presences).toEqual([
      { user_id: "12", status: "online" },
      { user_id: "13", status: "idle" },
    ]);
    // Fase 5: voice_states (array, nunca null)
    expect(ready.d.voice_states).toEqual([
      {
        guild_id: "100",
        channel_id: "301",
        user_id: "12",
        self_mute: false,
        self_deaf: false,
        self_video: true,
        self_screen: false,
      },
    ]);
    const resumed = dispatchFrameSchema("RESUMED").parse(fixtures.resumed);
    expect(resumed.s).toBeNull(); // RESUMED não consome sequência
    expect(resumed.d.replayed).toBe(3);
  });

  const names = Object.keys(fixtures.dispatch) as GatewayEventName[];

  it("op 12 (cliente -> servidor) e CHANNEL_CREATE de DM em grupo", () => {
    expect(setPresenceFrameSchema.parse(fixtures.set_presence).d).toEqual({ status: "idle" });
    const dm = dispatchFrameSchema("CHANNEL_CREATE").parse(fixtures.dm_channel_create);
    expect(dm.d.recipients?.map((r) => r.username)).toEqual(["gustavo", "maria", "joao"]);
    expect(
      setPresenceFrameSchema.safeParse({ ...fixtures.set_presence, d: { status: "offline" } })
        .success,
    ).toBe(false);
  });

  it("READY sem os campos da Fase 4 (servidor antigo) vira arrays vazios", () => {
    const { private_channels: _a, presences: _b, voice_states: _c, ...old } = fixtures.ready.d;
    const parsed = eventSchemas.READY.parse(old);
    expect(parsed.private_channels).toEqual([]);
    expect(parsed.presences).toEqual([]);
    expect(parsed.voice_states).toEqual([]);
  });

  it("VOICE_STATE_UPDATE: o fixture do Go e as variantes de saída e de DM", () => {
    const frame = dispatchFrameSchema("VOICE_STATE_UPDATE").parse(
      fixtures.dispatch.VOICE_STATE_UPDATE,
    );
    expect(frame.d).toMatchObject({ channel_id: "301", self_mute: true, self_video: true });
    // Saída da voz: channel_id nulo. DM: guild_id nulo.
    const left = { ...frame.d, channel_id: null };
    const inDm = { ...frame.d, guild_id: null, channel_id: "500" };
    expect(eventSchemas.VOICE_STATE_UPDATE.safeParse(left).success).toBe(true);
    expect(eventSchemas.VOICE_STATE_UPDATE.safeParse(inDm).success).toBe(true);
    // Campo faltando (ex.: self_screen) é violação de contrato.
    const { self_screen: _s, ...broken } = frame.d;
    expect(eventSchemas.VOICE_STATE_UPDATE.safeParse(broken).success).toBe(false);
  });

  it("o fixture cobre todos os eventos do schema (e só eles)", () => {
    const all = Object.keys(eventSchemas).filter((n) => n !== "READY" && n !== "RESUMED");
    expect([...names].sort()).toEqual(all.sort());
  });

  it.each(names)("dispatch %s", (name) => {
    const raw = fixtures.dispatch[name as keyof typeof fixtures.dispatch];
    expect(frameSchema.safeParse(raw).success).toBe(true);
    const frame = dispatchFrameSchema(name).parse(raw);
    expect(frame.t).toBe(name);
    expect(frame.s).not.toBeNull();
  });

  it("os schemas rejeitam payload fora do contrato", () => {
    const bad = { ...fixtures.dispatch.MESSAGE_CREATE, d: { id: 1 } };
    expect(dispatchFrameSchema("MESSAGE_CREATE").safeParse(bad).success).toBe(false);
    const status = { ...fixtures.dispatch.PRESENCE_UPDATE.d, status: "dnd" };
    expect(eventSchemas.PRESENCE_UPDATE.safeParse(status).success).toBe(false);
  });

  it("códigos de fechamento batem com o servidor", () => {
    expect(CloseCode).toEqual(fixtures.close_codes);
  });
});
