import { beforeEach, describe, expect, it } from "vitest";
import { participantsOf, useVoiceStatesStore, useVoiceStore } from "./store";

const vs = (user: string, ch: string | null, x = {}) => ({
  guild_id: ch ? "g1" : null,
  channel_id: ch,
  user_id: user,
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen: false,
  screen_preview: false,
  ...x,
});

beforeEach(() => {
  useVoiceStatesStore.getState().reset();
  useVoiceStore.getState().reset();
});

describe("mapa de voice states", () => {
  it("READY substitui tudo e ignora entradas sem canal", () => {
    const st = useVoiceStatesStore.getState();
    st.apply(vs("9", "c1"));
    st.replaceAll([vs("1", "c1"), vs("2", "c2"), vs("3", null)]);
    expect(Object.keys(useVoiceStatesStore.getState().byUser).sort()).toEqual(["1", "2"]);
  });

  it("update entra, muda de canal, atualiza flags e sai (channel_id null)", () => {
    const st = useVoiceStatesStore.getState();
    st.apply(vs("1", "c1"));
    st.apply(vs("1", "c2", { self_mute: true, self_video: true }));
    expect(useVoiceStatesStore.getState().byUser["1"]).toMatchObject({
      channel_id: "c2",
      self_mute: true,
      self_video: true,
    });
    st.apply(vs("1", null));
    expect(useVoiceStatesStore.getState().byUser).toEqual({});
  });

  it("saída de quem não está no mapa não notifica (mesmo objeto)", () => {
    const before = useVoiceStatesStore.getState().byUser;
    useVoiceStatesStore.getState().apply(vs("7", null));
    expect(useVoiceStatesStore.getState().byUser).toBe(before);
  });

  it("participantsOf filtra por canal em ordem estável de id", () => {
    const st = useVoiceStatesStore.getState();
    st.replaceAll([vs("20", "c1"), vs("3", "c1"), vs("5", "c2")]);
    expect(
      participantsOf(useVoiceStatesStore.getState().byUser, "c1").map((p) => p.user_id),
    ).toEqual(["3", "20"]);
  });
});

describe("sessão local", () => {
  it("begin zera mídia mas clear preserva mudo/surdo", () => {
    const st = useVoiceStore.getState();
    st.patch({ selfMute: true, selfDeaf: true, camera: true });
    st.begin({ channelId: "c1", guildId: "g1", channelName: "Geral" });
    expect(useVoiceStore.getState()).toMatchObject({
      status: "connecting",
      camera: false,
      selfMute: true,
      confirmed: false,
    });
    useVoiceStore.getState().clear();
    expect(useVoiceStore.getState()).toMatchObject({
      status: "idle",
      channelId: null,
      selfMute: true,
      selfDeaf: true,
    });
  });
});
