import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "@/test/server";
import { desiredWatchTargets, startScreenWatchNotifier, WATCH_HEARTBEAT_MS } from "./screen-watch";
import { useVoiceStatesStore, useVoiceStore } from "./store";

const st = (user_id: string, channel_id: string | null, self_screen: boolean) => ({
  guild_id: "g1",
  channel_id,
  user_id,
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen,
  screen_preview: false,
});

describe("desiredWatchTargets", () => {
  const byUser = {
    "1": st("1", "c1", true), // eu
    "2": st("2", "c1", true),
    "3": st("3", "c1", true),
    "4": st("4", "c1", false), // não transmite
    "5": st("5", "c2", true), // outro canal
  };
  it("com engine seletiva só conta o que escolhi assistir; nunca eu, quem não transmite nem outro canal", () => {
    expect(desiredWatchTargets("1", "c1", true, new Set(["2", "4", "5", "1"]), byUser)).toEqual([
      "2",
    ]);
    expect(desiredWatchTargets("1", "c1", true, new Set(), byUser)).toEqual([]);
  });
  it("sem engine seletiva (desktop assina tudo) conta todas as telas do canal", () => {
    expect(desiredWatchTargets("1", "c1", false, new Set(), byUser)).toEqual(["2", "3"]);
    expect(desiredWatchTargets("1", null, false, new Set(), byUser)).toEqual([]);
  });
});

type Call = { method: string; path: string };
let calls: Call[];
let putStatus: number;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  calls = [];
  putStatus = 204;
  useVoiceStore.getState().reset();
  useVoiceStatesStore.getState().reset();
  server.use(
    http.put("*/api/channels/:cid/voice/screen-watch/:uid", ({ request }) => {
      calls.push({ method: "PUT", path: new URL(request.url).pathname });
      return putStatus === 204
        ? new HttpResponse(null, { status: 204 })
        : HttpResponse.json({ title: "x", status: putStatus, detail: "x" }, { status: putStatus });
    }),
    http.delete("*/api/channels/:cid/voice/screen-watch/:uid", ({ request }) => {
      calls.push({ method: "DELETE", path: new URL(request.url).pathname });
      return new HttpResponse(null, { status: 204 });
    }),
  );
});
afterEach(() => {
  vi.useRealTimers();
});

const connect = (watching: string[] = []) => {
  useVoiceStore.getState().begin({ channelId: "c1", guildId: "g1", channelName: "Geral" });
  useVoiceStore.getState().patch({ status: "connected", watching: new Set(watching) });
};
const flush = async (ms = 50) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe("startScreenWatchNotifier", () => {
  it("avisa ao começar a assistir, renova a cada 20 s e apaga ao parar", async () => {
    useVoiceStatesStore.getState().replaceAll([st("1", "c1", false), st("2", "c1", true)]);
    connect();
    const stop = startScreenWatchNotifier({ myId: () => "1", selective: () => true });
    await flush();
    expect(calls).toEqual([]); // ainda não assisto a ninguém

    useVoiceStore.getState().patch({ watching: new Set(["2"]) });
    await flush();
    expect(calls).toEqual([{ method: "PUT", path: "/api/channels/c1/voice/screen-watch/2" }]);

    await flush(WATCH_HEARTBEAT_MS + 100);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);

    useVoiceStore.getState().patch({ watching: new Set() });
    await flush();
    expect(calls.at(-1)).toEqual({
      method: "DELETE",
      path: "/api/channels/c1/voice/screen-watch/2",
    });
    const n = calls.length;
    await flush(WATCH_HEARTBEAT_MS * 2);
    expect(calls).toHaveLength(n); // parou de renovar
    stop();
  });

  it("sem engine seletiva avisa todas as telas do canal; quando a transmissão acaba, para sem apagar nada", async () => {
    useVoiceStatesStore
      .getState()
      .replaceAll([st("1", "c1", false), st("2", "c1", true), st("3", "c1", true)]);
    connect();
    const stop = startScreenWatchNotifier({ myId: () => "1", selective: () => false });
    await flush();
    expect(calls.map((c) => c.path).sort()).toEqual([
      "/api/channels/c1/voice/screen-watch/2",
      "/api/channels/c1/voice/screen-watch/3",
    ]);
    useVoiceStatesStore.getState().apply(st("3", "c1", false)); // parou de transmitir
    await flush();
    expect(calls.at(-1)?.method).toBe("DELETE");
    stop();
  });

  it("sair da chamada para tudo (o servidor já tira as marcas de quem sai)", async () => {
    useVoiceStatesStore.getState().replaceAll([st("2", "c1", true)]);
    connect(["2"]);
    const stop = startScreenWatchNotifier({ myId: () => "1", selective: () => true });
    await flush();
    expect(calls).toHaveLength(1);
    useVoiceStore.getState().clear();
    await flush(WATCH_HEARTBEAT_MS * 2);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(1);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    stop();
  });

  it("404 (transmissão acabou) não insiste; 403 (servidor ainda não me viu na sala) tenta de novo em 3 s", async () => {
    useVoiceStatesStore.getState().replaceAll([st("2", "c1", true)]);
    putStatus = 403;
    connect(["2"]);
    const stop = startScreenWatchNotifier({ myId: () => "1", selective: () => true });
    await flush();
    expect(calls).toHaveLength(1);
    putStatus = 204;
    await flush(3_100);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(2);
    stop();
    await flush();

    calls.length = 0;
    putStatus = 404;
    const stop2 = startScreenWatchNotifier({ myId: () => "1", selective: () => true });
    await flush();
    expect(calls).toHaveLength(1);
    await flush(WATCH_HEARTBEAT_MS * 2);
    expect(calls).toHaveLength(1);
    stop2();
  });
});
