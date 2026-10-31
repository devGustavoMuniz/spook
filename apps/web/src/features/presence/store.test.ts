import { beforeEach, describe, expect, it } from "vitest";
import { usePresenceStore } from "./store";

const statuses = () => usePresenceStore.getState().statuses;

beforeEach(() => usePresenceStore.getState().reset());

describe("store de presença", () => {
  it("replaceAll troca tudo pelo snapshot e ignora offline", () => {
    const s = usePresenceStore.getState();
    s.set("9", "online");
    s.replaceAll([
      { user_id: "1", status: "online" },
      { user_id: "2", status: "idle" },
      { user_id: "3", status: "offline" },
    ]);
    expect(statuses()).toEqual({ "1": "online", "2": "idle" });
  });

  it("set atualiza um usuário; offline remove (quem não está no mapa é offline)", () => {
    const s = usePresenceStore.getState();
    s.set("1", "online");
    s.set("1", "idle");
    expect(statuses()).toEqual({ "1": "idle" });
    s.set("1", "offline");
    expect(statuses()).toEqual({});
  });

  it("não troca a referência quando nada mudou (evita re-render dos indicadores)", () => {
    const s = usePresenceStore.getState();
    s.set("1", "online");
    const before = statuses();
    s.set("1", "online");
    s.set("2", "offline");
    expect(statuses()).toBe(before);
  });
});
