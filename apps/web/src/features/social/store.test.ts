import type { RelationshipPayload } from "@spook/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { callPayload } from "@/test/social";
import { firstIncoming, useCallStore } from "./call-store";
import { useSocialStore } from "./store";

const rel = (id: string, type: RelationshipPayload["type"]): RelationshipPayload => ({
  user: { id, username: `u${id}` },
  type,
  since: "2026-11-03T12:00:00Z",
});

beforeEach(() => {
  useSocialStore.getState().reset();
  useCallStore.getState().reset();
});

describe("store de amizades", () => {
  it("o READY semeia amigos, pedidos, bloqueados e a contagem de pedidos recebidos", () => {
    useSocialStore.getState().replaceAll({
      friend_count: 1,
      incoming_count: 3,
      outgoing_count: 0,
      blocked_ids: ["9"],
      items: [rel("2", "friend"), rel("3", "incoming")],
      truncated: false,
    });
    const s = useSocialStore.getState();
    expect(Object.keys(s.rels)).toEqual(["2", "3"]);
    expect(s.blocked).toEqual({ "9": true });
    expect(s.incomingCount).toBe(3); // a contagem do servidor vale mesmo com lista truncada
    useSocialStore.getState().replaceAll(undefined);
    expect(useSocialStore.getState().incomingCount).toBe(0);
  });

  it("ADD/UPDATE/REMOVE mantêm a contagem de pedidos recebidos", () => {
    const st = useSocialStore.getState();
    st.upsert(rel("3", "incoming"));
    st.upsert(rel("3", "incoming")); // repetido: não conta duas vezes
    st.upsert(rel("4", "incoming"));
    expect(useSocialStore.getState().incomingCount).toBe(2);
    st.upsert(rel("3", "friend")); // aceito
    expect(useSocialStore.getState().incomingCount).toBe(1);
    st.remove("4"); // recusado
    expect(useSocialStore.getState().incomingCount).toBe(0);
    st.remove("99");
    expect(useSocialStore.getState().incomingCount).toBe(0);
  });

  it("bloquear tira o relacionamento e marca como bloqueado; desbloquear (REMOVE) limpa", () => {
    const st = useSocialStore.getState();
    st.upsert(rel("2", "friend"));
    st.upsert(rel("5", "incoming"));
    st.upsert(rel("2", "blocked"));
    st.upsert(rel("5", "blocked"));
    const s = useSocialStore.getState();
    expect(s.rels).toEqual({});
    expect(s.blocked).toEqual({ "2": true, "5": true });
    expect(s.incomingCount).toBe(0);
    st.remove("2");
    expect(useSocialStore.getState().blocked).toEqual({ "5": true });
    // voltar a ser pedido de quem estava bloqueado tira o bloqueio
    st.upsert(rel("5", "outgoing"));
    expect(useSocialStore.getState().blocked).toEqual({});
  });
});

describe("store de chamadas", () => {
  const ME = "1";
  it("CALL_RING entra em incoming; ordem pela mais antiga", () => {
    const c = useCallStore.getState();
    c.ring(callPayload("200", { started_at: "2026-11-03T12:00:05Z" }));
    c.ring(callPayload("100", { started_at: "2026-11-03T12:00:00Z" }));
    expect(firstIncoming(useCallStore.getState().incoming)?.channel_id).toBe("100");
  });

  it("minha chamada tocando vira outgoing; atendida (active) limpa o Chamando…", () => {
    const c = useCallStore.getState();
    c.update(ME, callPayload("100", { started_by: ME, state: "ringing" }));
    expect(Object.keys(useCallStore.getState().outgoing)).toEqual(["100"]);
    c.update(
      ME,
      callPayload("100", { started_by: ME, state: "active", reason: "answered", user_id: "50" }),
    );
    expect(useCallStore.getState().outgoing).toEqual({});
  });

  it("quem atende ou recusa em outro dispositivo para de tocar aqui; os demais seguem tocando", () => {
    const c = useCallStore.getState();
    c.ring(callPayload("100"));
    c.ring(callPayload("200"));
    c.update(ME, callPayload("100", { state: "active", reason: "answered", user_id: ME }));
    expect(Object.keys(useCallStore.getState().incoming)).toEqual(["200"]);
    // outra pessoa do grupo atendeu: a minha continua tocando
    c.update(
      ME,
      callPayload("200", { state: "active", reason: "answered", user_id: "70", group: true }),
    );
    expect(Object.keys(useCallStore.getState().incoming)).toEqual(["200"]);
    c.update(ME, callPayload("200", { state: "ringing", reason: "declined", user_id: ME }));
    expect(useCallStore.getState().incoming).toEqual({});
  });

  it("CALL_END limpa os dois mapas", () => {
    const c = useCallStore.getState();
    c.ring(callPayload("100"));
    c.setOutgoing(callPayload("200", { started_by: ME }));
    c.end("100");
    c.end("200");
    expect(useCallStore.getState()).toMatchObject({ incoming: {}, outgoing: {} });
  });
});
