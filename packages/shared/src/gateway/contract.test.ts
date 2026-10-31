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
    const resumed = dispatchFrameSchema("RESUMED").parse(fixtures.resumed);
    expect(resumed.s).toBeNull(); // RESUMED não consome sequência
    expect(resumed.d.replayed).toBe(3);
  });

  const names = Object.keys(fixtures.dispatch) as GatewayEventName[];

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
