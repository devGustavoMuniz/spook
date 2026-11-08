import { Permission, type VoiceStatePayload } from "@spook/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { guild, ME } from "@/test/fixtures";
import { makeBackend, server } from "@/test/server";
import { resetVoiceController } from "../controller";
import type { VideoTrackInfo } from "../engine";
import { setVoiceEngineFactory } from "../engine-provider";
import { useVoiceStatesStore, useVoiceStore } from "../store";
import { useCallLayoutStore } from "./call-layout";
import { VoiceStage } from "./voice-stage";

const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toasts }));

const state = (user_id: string, extra: Partial<VoiceStatePayload> = {}): VoiceStatePayload => ({
  guild_id: "g1",
  channel_id: "c1",
  user_id,
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen: false,
  screen_preview: false,
  ...extra,
});
const names: Record<string, string> = { [ME]: "Ana", "7": "Bia", "8": "Caio", "9": "Dani" };
const lookup = (id: string) => ({ name: names[id] ?? "Usuário" });
const FULL =
  Permission.VIEW_CHANNEL |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO |
  Permission.CREATE_INVITE;

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

function track(id: string, identity: string, kind: "camera" | "screen", local = false) {
  const info: VideoTrackInfo = {
    id,
    identity,
    kind,
    local,
    source: {
      attach(host) {
        const v = document.createElement("video");
        host.appendChild(v);
        return () => v.remove();
      },
    },
  };
  return info;
}

let fake: FakeVoiceEngine;

function mount(participants: VoiceStatePayload[]) {
  const g = guild("g1", "Alfa", { permissions: FULL });
  const backend = makeBackend({ signedIn: true });
  backend.state.guilds.push(g);
  server.use(...backend.handlers);
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  return render(
    <QueryClientProvider client={client}>
      <VoiceStage participants={participants} lookup={lookup} inCall guild={g} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  fake = new FakeVoiceEngine();
  fake.audioCapabilities = {
    strongNoiseSuppression: false,
    screenWatch: true,
    screenSourceSwap: true,
  };
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
  useCallLayoutStore.setState({ layout: "grid" });
  useVoiceStore.setState({
    status: "connected",
    channelId: "c1",
    guildId: "g1",
    videoTracks: [],
    speaking: new Set(),
  });
  HTMLVideoElement.prototype.play = vi.fn(async () => {});
});
afterEach(() => {
  setVoiceEngineFactory(null);
  resetVoiceController();
  vi.useRealTimers();
});

/** O estado do controlador só conhece a engine depois que algo a cria. */
async function warmEngine() {
  const { audioCapabilities } = await import("../controller");
  audioCapabilities();
}

describe("escolher quais telas assistir", () => {
  it("a tela de quem transmite começa sem assinatura, com botão 'Assistir'", async () => {
    await warmEngine();
    mount([state(ME), state("7", { self_screen: true })]);
    const tile = await screen.findByLabelText("Tela de Bia");
    expect(tile).toHaveAttribute("data-kind", "screen");
    expect(within(tile).getByRole("button", { name: "Assistir tela de Bia" })).toBeInTheDocument();
    expect(screen.queryByTestId("video-tile")).not.toBeInTheDocument();
  });

  it("Assistir assina pela engine; chegando a faixa vira vídeo com 'Parar de assistir'", async () => {
    const user = userEvent.setup();
    await warmEngine();
    mount([state(ME), state("7", { self_screen: true })]);
    useVoiceStore.setState({ status: "connected" });
    await user.click(await screen.findByRole("button", { name: "Assistir tela de Bia" }));
    expect(fake.watches).toEqual([["7", true]]);
    expect(useVoiceStore.getState().watching.has("7")).toBe(true);
    act(() => useVoiceStore.setState({ videoTracks: [track("t1", "7", "screen")] }));
    expect(screen.getByTestId("video-tile")).toHaveAttribute("data-kind", "screen");
    await user.click(screen.getByRole("button", { name: "Parar de assistir a tela de Bia" }));
    expect(fake.watches.at(-1)).toEqual(["7", false]);
    expect(useVoiceStore.getState().watching.has("7")).toBe(false);
  });

  it("'Parar de assistir' também está no menu do tile", async () => {
    const user = userEvent.setup();
    await warmEngine();
    act(() => useVoiceStore.setState({ videoTracks: [track("t1", "7", "screen")] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await user.click(screen.getByRole("button", { name: "Opções de Tela de Bia" }));
    await user.click(await screen.findByRole("menuitem", { name: /Parar de assistir/ }));
    expect(fake.watches.at(-1)).toEqual(["7", false]);
  });

  it("engine sem a capacidade (desktop) não cria o tile de 'Assistir' e mantém o comportamento atual", async () => {
    fake.audioCapabilities = { strongNoiseSuppression: false };
    await warmEngine();
    mount([state(ME), state("7", { self_screen: true })]);
    expect(screen.queryByRole("button", { name: /Assistir tela/ })).not.toBeInTheDocument();
    act(() => useVoiceStore.setState({ videoTracks: [track("t1", "7", "screen")] }));
    expect(screen.queryByRole("button", { name: /Parar de assistir/ })).not.toBeInTheDocument();
    expect(screen.getByTestId("video-tile")).toBeInTheDocument();
  });

  it("minha própria tela nunca vira tile para assistir", async () => {
    await warmEngine();
    mount([state(ME, { self_screen: true })]);
    await screen.findByLabelText("Ana");
    expect(screen.queryByRole("button", { name: /Assistir tela/ })).not.toBeInTheDocument();
  });
});

describe("layouts da chamada", () => {
  it("o padrão é a grade", () => {
    mount([state(ME), state("7"), state("8")]);
    expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("participant-tile")).toHaveLength(3);
  });

  it("Foco põe um tile grande e os demais numa faixa", () => {
    useCallLayoutStore.setState({ layout: "focus" });
    act(() => useVoiceStore.setState({ speaking: new Set(["8"]) }));
    mount([state(ME), state("7"), state("8")]);
    const main = screen.getByRole("list", { name: "Em destaque" });
    expect(within(main).getByLabelText("Caio")).toBeInTheDocument();
    const strip = screen.getByRole("list", { name: "Participantes da chamada" });
    expect(within(strip).getAllByRole("listitem")).toHaveLength(2);
  });

  it("Ocultar inativos esconde quem não fala nem tem vídeo e conta os ocultos", async () => {
    useCallLayoutStore.setState({ layout: "active" });
    act(() => useVoiceStore.setState({ speaking: new Set(["8"]) }));
    mount([state(ME), state("7"), state("8"), state("9")]);
    expect(screen.queryByLabelText("Bia")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Caio")).toBeInTheDocument();
    // eu (só reconhecido depois que o perfil carrega) fico sempre visível
    expect(await screen.findByLabelText("Ana")).toBeInTheDocument();
    expect(screen.getByTestId("hidden-count")).toHaveTextContent("2 participantes ocultos");
  });

  it("o seletor da barra troca o layout e persiste", async () => {
    const user = userEvent.setup();
    mount([state(ME), state("7")]);
    await user.click(screen.getByRole("button", { name: "Layout da chamada: Grade" }));
    await user.click(await screen.findByRole("menuitemradio", { name: /Foco/ }));
    expect(useCallLayoutStore.getState().layout).toBe("focus");
    expect(localStorage.getItem("spook:call-layout")).toBe("focus");
    expect(screen.getByRole("list", { name: "Em destaque" })).toBeInTheDocument();
  });

  it("a tecla L alterna os layouts", () => {
    mount([state(ME), state("7")]);
    const stage = screen.getByRole("region", { name: "Vídeo da chamada" });
    fireEvent.keyDown(stage, { key: "l" });
    expect(useCallLayoutStore.getState().layout).toBe("focus");
    fireEvent.keyDown(stage, { key: "l" });
    expect(useCallLayoutStore.getState().layout).toBe("active");
    fireEvent.keyDown(stage, { key: "l" });
    expect(useCallLayoutStore.getState().layout).toBe("grid");
  });
});

describe("trocar a fonte da tela", () => {
  it("a barra oferece 'Trocar janela/tela' só enquanto compartilho, e chama a engine", async () => {
    const user = userEvent.setup();
    await warmEngine();
    mount([state(ME), state("7")]);
    expect(screen.queryByRole("button", { name: "Trocar janela/tela" })).not.toBeInTheDocument();
    act(() => useVoiceStore.setState({ screen: true }));
    await user.click(await screen.findByRole("button", { name: "Trocar janela/tela" }));
    expect(fake.swaps).toHaveLength(1);
  });

  it("o menu do tile da minha tela também troca a fonte", async () => {
    const user = userEvent.setup();
    await warmEngine();
    act(() =>
      useVoiceStore.setState({ screen: true, videoTracks: [track("t9", ME, "screen", true)] }),
    );
    mount([state(ME, { self_screen: true }), state("7")]);
    await user.click(screen.getByRole("button", { name: "Opções de Sua tela" }));
    await user.click(await screen.findByRole("menuitem", { name: /Trocar janela\/tela/ }));
    expect(fake.swaps).toHaveLength(1);
  });

  it("no desktop (sem a capacidade) o botão não existe", async () => {
    fake.audioCapabilities = { strongNoiseSuppression: false };
    await warmEngine();
    act(() => useVoiceStore.setState({ screen: true }));
    mount([state(ME), state("7")]);
    expect(screen.queryByRole("button", { name: "Trocar janela/tela" })).not.toBeInTheDocument();
  });
});

describe("tela cheia do palco inteiro e controles por ociosidade", () => {
  let fsEl: Element | null = null;
  beforeEach(() => {
    fsEl = null;
    Object.defineProperty(document, "fullscreenElement", { configurable: true, get: () => fsEl });
    document.exitFullscreen = vi.fn(async () => {
      fsEl = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    Element.prototype.requestFullscreen = vi.fn(async function (this: Element) {
      fsEl = this;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
  });

  it("o botão pede tela cheia no palco (a seção toda, não só o tile)", async () => {
    const user = userEvent.setup();
    mount([state(ME), state("7")]);
    const stage = screen.getByRole("region", { name: "Vídeo da chamada" });
    await user.click(screen.getByRole("button", { name: "Tela cheia do palco" }));
    expect(fsEl).toBe(stage);
    expect(stage).toHaveAttribute("data-fullscreen");
  });

  it("em tela cheia, barra e cursor somem após ~3 s sem movimento e voltam com o mouse", () => {
    vi.useFakeTimers();
    mount([state(ME), state("7")]);
    const stage = screen.getByRole("region", { name: "Vídeo da chamada" });
    act(() => {
      fsEl = stage;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(stage).toHaveAttribute("data-controls", "visible");
    act(() => void vi.advanceTimersByTime(3100));
    expect(stage).toHaveAttribute("data-controls", "hidden");
    expect(stage.className).toContain("cursor-none");
    fireEvent.pointerMove(stage, { pointerType: "mouse" });
    expect(stage).toHaveAttribute("data-controls", "visible");
    expect(stage.className).not.toContain("cursor-none");
  });

  it("a tecla F alterna a tela cheia; sair (Esc do navegador) restaura os controles", async () => {
    mount([state(ME), state("7")]);
    const stage = screen.getByRole("region", { name: "Vídeo da chamada" });
    fireEvent.keyDown(stage, { key: "f" });
    await waitFor(() => expect(stage).toHaveAttribute("data-fullscreen"));
    act(() => {
      fsEl = null;
      document.dispatchEvent(new Event("fullscreenchange"));
    });
    expect(stage).not.toHaveAttribute("data-fullscreen");
  });
});

describe("menus de dispositivo na barra do palco", () => {
  it("botão direito no microfone lista os dispositivos e troca o escolhido", async () => {
    const user = userEvent.setup();
    mount([state(ME), state("7")]);
    fireEvent.contextMenu(screen.getByRole("button", { name: "Silenciar microfone" }));
    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Microfone")).toBeInTheDocument();
    await user.click(await within(menu).findByRole("menuitemradio", { name: "Microfone USB" }));
    expect(fake.setDevices).toContainEqual(["audioinput", "mic1"]);
    expect(JSON.parse(localStorage.getItem("spook:voice-devices") ?? "{}")).toMatchObject({
      audioinput: "mic1",
    });
  });

  it("a setinha do fone lista as saídas e tem 'Configurações de voz'", async () => {
    const user = userEvent.setup();
    mount([state(ME), state("7")]);
    await user.click(screen.getByRole("button", { name: "Escolher alto-falante" }));
    const menu = await screen.findByRole("menu");
    expect(
      await within(menu).findByRole("menuitemradio", { name: "Caixa de som" }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole("menuitem", { name: /Configurações de voz/ }),
    ).toBeInTheDocument();
  });
});
