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
      { user_id: "14", status: "dnd", custom_status: { emoji: "🎧" } },
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
        screen_preview: false,
      },
    ]);
    // Fase 6b: read_states (só canais com não lidas ou menções; array, nunca null)
    expect(Array.isArray(fixtures.ready.d.read_states)).toBe(true);
    expect(ready.d.read_states?.[0]).toMatchObject({
      channel_id: "300",
      guild_id: "100",
      mention_count: 2,
      unread_count: 12,
    });
    expect(ready.d.read_states?.[1]?.guild_id).toBeUndefined(); // DM: sem guild_id
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

  it("MESSAGE_CREATE traz mention_ids e READ_STATE_UPDATE segue o fixture", () => {
    const msg = dispatchFrameSchema("MESSAGE_CREATE").parse(fixtures.dispatch.MESSAGE_CREATE);
    expect(msg.d.mention_ids).toEqual(["11"]);
    const rs = dispatchFrameSchema("READ_STATE_UPDATE").parse(fixtures.dispatch.READ_STATE_UPDATE);
    expect(rs.d).toEqual({ channel_id: "300", last_read_message_id: "901", mention_count: 2 });
  });

  it("status (dnd, status personalizado), preferência própria e configurações de notificação", () => {
    const up = dispatchFrameSchema("PRESENCE_UPDATE").parse(fixtures.dispatch.PRESENCE_UPDATE);
    expect(up.d).toMatchObject({ status: "dnd", custom_status: { text: "em foco", emoji: "🎧" } });
    const self = dispatchFrameSchema("PRESENCE_SELF_UPDATE").parse(
      fixtures.dispatch.PRESENCE_SELF_UPDATE,
    );
    expect(self.d.status_pref).toBe("invisible");
    const ns = dispatchFrameSchema("NOTIFICATION_SETTINGS_UPDATE").parse(
      fixtures.dispatch.NOTIFICATION_SETTINGS_UPDATE,
    );
    expect(ns.d).toMatchObject({ scope: "channel", muted: true, level: "mentions" });
    const ready = eventSchemas.READY.parse(fixtures.ready.d);
    expect(ready.self_presence.status_pref).toBe("online");
    expect(ready.notification_settings).toHaveLength(2);
    expect(ready.presences[2]).toMatchObject({ status: "dnd", custom_status: { emoji: "🎧" } });
    // Servidor anterior: sem os campos novos, os padrões entram.
    const { self_presence: _s, notification_settings: _n, ...old } = fixtures.ready.d;
    const parsed = eventSchemas.READY.parse(old);
    expect(parsed.self_presence).toEqual({ status_pref: "online" });
    expect(parsed.notification_settings).toEqual([]);
  });

  it("VOICE_STATE_UPDATE: o fixture do Go e as variantes de saída e de DM", () => {
    const frame = dispatchFrameSchema("VOICE_STATE_UPDATE").parse(
      fixtures.dispatch.VOICE_STATE_UPDATE,
    );
    expect(frame.d).toMatchObject({
      channel_id: "301",
      self_mute: true,
      self_video: true,
      screen_preview: false,
    });
    // Saída da voz: channel_id nulo. DM: guild_id nulo.
    const left = { ...frame.d, channel_id: null };
    const inDm = { ...frame.d, guild_id: null, channel_id: "500" };
    expect(eventSchemas.VOICE_STATE_UPDATE.safeParse(left).success).toBe(true);
    expect(eventSchemas.VOICE_STATE_UPDATE.safeParse(inDm).success).toBe(true);
    // Campo faltando (ex.: self_screen) é violação de contrato.
    const { self_screen: _s, ...broken } = frame.d;
    expect(eventSchemas.VOICE_STATE_UPDATE.safeParse(broken).success).toBe(false);
    // server_muted (moderação) só vem quando verdadeiro; ausente vale "não mutado".
    expect(frame.d.server_muted).toBeUndefined();
    expect(eventSchemas.VOICE_STATE_UPDATE.parse({ ...frame.d, server_muted: true })).toMatchObject(
      {
        server_muted: true,
      },
    );
    // screen_preview é adicional: um servidor anterior que não o manda segue válido (padrão: sem prévia).
    const { screen_preview: _p, ...old } = frame.d;
    expect(eventSchemas.VOICE_STATE_UPDATE.parse(old)).toMatchObject({ screen_preview: false });
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
    const status = { ...fixtures.dispatch.PRESENCE_UPDATE.d, status: "busy" };
    expect(eventSchemas.PRESENCE_UPDATE.safeParse(status).success).toBe(false);
  });

  it("códigos de fechamento batem com o servidor", () => {
    expect(CloseCode).toEqual(fixtures.close_codes);
  });
});
