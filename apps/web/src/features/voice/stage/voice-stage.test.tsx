import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import type { VideoTrackInfo } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";
import { closePictureInPicture } from "./pip";
import { useVoiceStatesStore, useVoiceStore } from "./store";
import { VideoGrid } from "./video-grid";

const toasts = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast: toasts }));

/** Faixa cuja fonte monta um <video> de verdade (como a engine web). */
function videoTrack(id: string, identity: string, kind: "camera" | "screen", local = false) {
  const detached: string[] = [];
  const info: VideoTrackInfo = {
    id,
    identity,
    kind,
    local,
    source: {
      attach(host) {
        const v = document.createElement("video");
        v.dataset.src = id;
        host.appendChild(v);
        return () => {
          detached.push(id);
          v.remove();
        };
      },
    },
  };
  return { info, detached };
}

let fake: FakeVoiceEngine;
const lookup = (id: string) => ({ name: id === "7" ? "Bia" : "Usuário" });
let pipElement: Element | null = null;
let requested: HTMLVideoElement[] = [];

beforeEach(() => {
  localStorage.clear();
  fake = new FakeVoiceEngine();
  fake.audioCapabilities = { strongNoiseSuppression: false, pictureInPicture: true };
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
  useVoiceStore.setState({ status: "connected", channelId: "c1", videoTracks: [] });
  pipElement = null;
  requested = [];
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => pipElement,
  });
  document.exitPictureInPicture = vi.fn(async () => {
    const el = pipElement;
    pipElement = null;
    el?.dispatchEvent(new Event("leavepictureinpicture"));
  });
  HTMLVideoElement.prototype.play = vi.fn(async () => {});
  Object.defineProperty(HTMLVideoElement.prototype, "readyState", {
    configurable: true,
    get: () => 4,
  });
  HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(async function (
    this: HTMLVideoElement,
  ) {
    requested.push(this);
    pipElement = this;
    return {} as PictureInPictureWindow;
  });
});
afterEach(async () => {
  await closePictureInPicture();
  setVoiceEngineFactory(null);
  resetVoiceController();
  toasts.error.mockClear();
});

const pipButton = (name: RegExp) => screen.queryByRole("button", { name });

describe("VideoGrid: Picture-in-Picture", () => {
  it("o botão só existe em vídeo de outra pessoa, quando a engine declara a capacidade", async () => {
    const remote = videoTrack("t1", "7", "screen");
    const mine = videoTrack("t2", "1", "camera", true);
    act(() => useVoiceStore.setState({ videoTracks: [remote.info, mine.info] }));
    render(<VideoGrid lookup={lookup} />);
    expect(pipButton(/Janela flutuante: tela de Bia/)).toBeInTheDocument();
    expect(pipButton(/Janela flutuante: câmera de/)).toBeNull(); // a prévia local não
  });

  it("navegador sem suporte (ou engine nativa): o botão não aparece", () => {
    fake.audioCapabilities = { strongNoiseSuppression: false, pictureInPicture: false };
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    expect(pipButton(/Janela flutuante/)).toBeNull();
    expect(screen.getByRole("button", { name: /Tela cheia/ })).toBeInTheDocument();
  });

  it("abre a janela flutuante com um <video> próprio, marca o botão e fecha ao clicar de novo", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    const button = screen.getByRole("button", { name: /Janela flutuante: tela de Bia/ });
    expect(button).toHaveAttribute("aria-pressed", "false");
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    expect(requested).toHaveLength(1);
    // o <video> do PiP não é o do tile: sobrevive a remontar o painel
    expect(screen.getByTestId("video-tile").querySelector("video")).not.toBe(requested[0]);
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
    expect(document.exitPictureInPicture).toHaveBeenCalled();
  });

  it("a janela fecha sozinha quando a faixa termina", async () => {
    const user = userEvent.setup();
    const t = videoTrack("t1", "7", "camera");
    act(() => useVoiceStore.setState({ videoTracks: [t.info] }));
    render(<VideoGrid lookup={lookup} />);
    const button = screen.getByRole("button", { name: /Janela flutuante: câmera de Bia/ });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    act(() => useVoiceStore.setState({ videoTracks: [] }));
    await waitFor(() => expect(document.exitPictureInPicture).toHaveBeenCalled());
    expect(t.detached).toContain("t1");
  });

  it("a janela fecha quando a chamada termina", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    await user.click(screen.getByRole("button", { name: /Janela flutuante/ }));
    await waitFor(() => expect(requested).toHaveLength(1));
    act(() => useVoiceStore.setState({ status: "idle" }));
    await waitFor(() => expect(document.exitPictureInPicture).toHaveBeenCalled());
  });

  it("fechar pelo botão da própria janela do navegador limpa o estado", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    const button = screen.getByRole("button", { name: /Janela flutuante/ });
    await user.click(button);
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "true"));
    act(() => requested[0]?.dispatchEvent(new Event("leavepictureinpicture")));
    await waitFor(() => expect(button).toHaveAttribute("aria-pressed", "false"));
  });

  it("o navegador recusar vira um aviso, sem quebrar", async () => {
    const user = userEvent.setup();
    HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(async () => {
      throw new Error("recusou");
    });
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    await user.click(screen.getByRole("button", { name: /Janela flutuante/ }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/janela flutuante/)),
    );
  });

  it("fonte que não é <video> (canvas): não abre e avisa", async () => {
    const user = userEvent.setup();
    const t = fake.videoTrack("c1", "7", "screen"); // fonte desenha em <canvas>
    act(() => useVoiceStore.setState({ videoTracks: [t] }));
    render(<VideoGrid lookup={lookup} />);
    await user.click(screen.getByRole("button", { name: /Janela flutuante/ }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(requested).toHaveLength(0);
  });

  it("o botão se opera pelo teclado (Tab até ele e Enter)", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    const button = screen.getByRole("button", { name: /Janela flutuante/ });
    button.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(requested).toHaveLength(1));
    expect(button).toHaveFocus();
  });
});

describe("VideoGrid: volume da pessoa no tile em destaque", () => {
  beforeEach(() => {
    fake.audioCapabilities = {
      strongNoiseSuppression: false,
      participantVolume: { max: 1 },
    };
  });

  it("o tile em destaque tem o painel de volume (voz, e tela se ela compartilha) e silenciar só para mim", async () => {
    const user = userEvent.setup();
    // a engine precisa existir no controlador para declarar a capacidade
    const { joinVoice } = await import("./controller");
    const { makeBackend, server } = await import("@/test/server");
    server.use(...makeBackend({ signedIn: true }).handlers);
    await joinVoice({ channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: true });
    useVoiceStatesStore.getState().apply({
      guild_id: "g1",
      channel_id: "c1",
      user_id: "7",
      self_mute: false,
      self_deaf: false,
      self_video: false,
      self_screen: true,
    });
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    render(<VideoGrid lookup={lookup} />);
    await user.click(screen.getByRole("button", { name: "Volume de Bia" }));
    const panel = screen.getByRole("group", { name: "Volume de Bia" });
    expect(within(panel).getByRole("slider", { name: /Volume da voz de Bia/ })).toHaveAttribute(
      "max",
      "100",
    );
    expect(
      within(panel).getByRole("slider", { name: /Volume do áudio da tela de Bia/ }),
    ).toBeInTheDocument();
    await user.click(within(panel).getByRole("switch", { name: "Silenciar só para mim" }));
    expect(fake.volumes.at(-1)).toEqual(["7", "screen", 0]);
    expect(screen.getByRole("button", { name: "Volume de Bia" })).toBeInTheDocument();
  });
});
