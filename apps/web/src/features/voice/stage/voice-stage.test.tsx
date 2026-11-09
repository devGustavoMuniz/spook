import { Permission, type VoiceStatePayload } from "@spook/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NativeVoiceEngine } from "@/desktop/native-engine";
import { createQueryClient } from "@/lib/query";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { guild, ME } from "@/test/fixtures";
import { makeBackend, server } from "@/test/server";
import { resetVoiceController } from "../controller";
import type { VideoTrackInfo } from "../engine";
import { setVoiceEngineFactory } from "../engine-provider";
import { closePictureInPicture } from "../pip";
import { useVoiceStatesStore, useVoiceStore } from "../store";
import { VoiceStage } from "./voice-stage";

const toasts = vi.hoisted(() => ({
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
  dismiss: vi.fn(),
}));
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

// jsdom não tem PointerEvent: sem ele `pointerType` se perde nos eventos de teste.
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

let fake: FakeVoiceEngine;
let pipElement: Element | null = null;
let requested: HTMLVideoElement[] = [];

function mount(
  participants: VoiceStatePayload[],
  opts: { inCall?: boolean; guildPermissions?: number } = {},
) {
  const g = guild("g1", "Alfa", { permissions: opts.guildPermissions ?? FULL });
  const backend = makeBackend({ signedIn: true });
  backend.state.guilds.push(g);
  server.use(...backend.handlers);
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  const ui = (p: VoiceStatePayload[]) => (
    <QueryClientProvider client={client}>
      <VoiceStage participants={p} lookup={lookup} inCall={opts.inCall ?? true} guild={g} />
    </QueryClientProvider>
  );
  const view = render(ui(participants));
  return { ...view, update: (p: VoiceStatePayload[]) => view.rerender(ui(p)) };
}

beforeEach(() => {
  localStorage.clear();
  fake = new FakeVoiceEngine();
  fake.audioCapabilities = { strongNoiseSuppression: false, pictureInPicture: true };
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
  useVoiceStore.setState({
    status: "connected",
    channelId: "c1",
    guildId: "g1",
    videoTracks: [],
    speaking: new Set(),
  });
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
  vi.useRealTimers();
});

const tiles = () =>
  within(screen.getByRole("list", { name: "Participantes da chamada" })).getAllByRole("listitem");

describe("grade de tiles", () => {
  it("um tile por participante, com nome; o tile de convite só aparece com 1 pessoa", async () => {
    const view = mount([state(ME)]);
    expect(await screen.findByTestId("invite-tile")).toBeInTheDocument();
    expect(screen.getAllByTestId("participant-tile")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Convidar para voz" })).toBeEnabled();

    view.update([state(ME), state("7"), state("8")]);
    expect(screen.getAllByTestId("participant-tile")).toHaveLength(3);
    expect(screen.queryByTestId("invite-tile")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Bia")).toBeInTheDocument();
    expect(screen.getByLabelText("Caio")).toBeInTheDocument();

    view.update([state(ME), state("7")]);
    expect(screen.getAllByTestId("participant-tile")).toHaveLength(2);
  });

  it("os tiles recebem largura igual e ficam em 16:9 (cantos arredondados)", () => {
    mount([state(ME), state("7"), state("8"), state("9")]);
    const widths = new Set(tiles().map((t) => t.style.width));
    expect(widths.size).toBe(1);
    for (const t of tiles()) {
      expect(t).toHaveClass("aspect-video");
      expect(t).toHaveClass("rounded-xl");
    }
  });

  it("Convidar para voz abre as configurações do servidor na aba Convites", async () => {
    const user = userEvent.setup();
    mount([state(ME)]);
    await user.click(await screen.findByRole("button", { name: "Convidar para voz" }));
    const dialog = await screen.findByRole("dialog", {}, { timeout: 15_000 });
    expect(within(dialog).getByText("Convidar pessoas")).toBeInTheDocument();
    expect(
      await within(dialog).findByRole("tab", { name: "Convites", selected: true }),
    ).toBeTruthy();
  }, 20_000);

  it("sem permissão de criar convites, o botão fica desabilitado e explica o motivo", async () => {
    mount([state(ME)], { guildPermissions: Permission.VIEW_CHANNEL | Permission.CONNECT });
    const btn = await screen.findByRole("button", { name: "Convidar para voz" });
    expect(btn).toBeDisabled();
    expect(screen.getAllByText(/não tem permissão para criar convites/).length).toBeGreaterThan(0);
  });

  it("quem fala ganha o anel verde e o texto para leitores de tela", () => {
    mount([state(ME), state("7")]);
    expect(screen.getByLabelText("Bia")).not.toHaveAttribute("data-speaking");
    act(() => useVoiceStore.setState({ speaking: new Set(["7"]) }));
    expect(screen.getByLabelText("Bia")).toHaveAttribute("data-speaking", "true");
    expect(within(screen.getByLabelText("Bia")).getByText("(falando)")).toBeInTheDocument();
    expect(screen.getByLabelText("Caio" in names ? "Ana" : "Ana")).not.toHaveAttribute(
      "data-speaking",
    );
  });

  it("mostra mudo, surdo, câmera e tela no rodapé do tile", () => {
    mount([
      state(ME),
      state("7", { self_mute: true }),
      state("8", { self_deaf: true, self_mute: true }),
      state("9", { self_video: true, self_screen: true }),
    ]);
    expect(
      within(screen.getByLabelText("Bia")).getByRole("img", { name: "Microfone silenciado" }),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Caio")).getByRole("img", { name: "Áudio desativado" }),
    ).toBeInTheDocument();
    const dani = screen.getByLabelText("Dani");
    expect(within(dani).getByRole("img", { name: "Câmera ligada" })).toBeInTheDocument();
    expect(within(dani).getByRole("img", { name: "Compartilhando a tela" })).toBeInTheDocument();
  });

  it("prévia (fora da chamada): sem barra de controles nem menu", () => {
    mount([state("7")], { inCall: false });
    expect(screen.queryByRole("toolbar")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Opções de/ })).not.toBeInTheDocument();
    expect(screen.queryByTestId("invite-tile")).not.toBeInTheDocument();
  });
});

describe("foco e tela", () => {
  it("câmera ligada vira vídeo no tile; clicar destaca (tile grande + tira) e clicar de novo volta", async () => {
    const user = userEvent.setup();
    const cam = videoTrack("t1", "7", "camera");
    act(() => useVoiceStore.setState({ videoTracks: [cam.info] }));
    mount([state(ME), state("7", { self_video: true }), state("8")]);
    expect(screen.getAllByTestId("video-tile")).toHaveLength(1);
    expect(screen.getByLabelText("Bia").querySelector("video")).not.toBeNull();

    await user.click(screen.getByRole("button", { name: "Destacar câmera de Bia" }));
    const main = screen.getByRole("list", { name: "Em destaque" });
    expect(within(main).getByLabelText("Bia")).toHaveAttribute("data-focused", "true");
    expect(
      within(screen.getByRole("list", { name: "Participantes da chamada" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Voltar à grade: câmera de Bia" }));
    expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
    expect(tiles()).toHaveLength(3);
  });

  it("Enter num tile de vídeo destaca e Esc volta à grade", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    const btn = screen.getByRole("button", { name: "Destacar tela de Bia" });
    btn.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("list", { name: "Em destaque" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
  });

  it("a tela compartilhada é um tile à parte, rotulado 'Tela de X'", () => {
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    const screenTile = screen.getByTestId("video-tile");
    expect(screenTile).toHaveAttribute("data-kind", "screen");
    expect(screenTile).toHaveAccessibleName("Tela de Bia");
    expect(screen.getAllByTestId("participant-tile")).toHaveLength(2);
  });

  it("Tela cheia do tile destaca e pede a Fullscreen API", async () => {
    const user = userEvent.setup();
    const request = vi.fn(async () => {});
    Element.prototype.requestFullscreen = request;
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await user.click(screen.getByRole("button", { name: "Tela cheia: tela de Bia" }));
    expect(request).toHaveBeenCalled();
    expect(screen.getByRole("list", { name: "Em destaque" })).toBeInTheDocument();
  });
});

describe("botão vermelho da barra conforme o estado", () => {
  const bar = () => within(screen.getByTestId("stage-controls"));

  it("sem tela: 'Sair do canal' e nenhum botão secundário", () => {
    mount([state(ME), state("7")]);
    expect(bar().getByRole("button", { name: "Sair do canal" })).toBeInTheDocument();
    expect(bar().queryByRole("button", { name: "Sair da transmissão" })).not.toBeInTheDocument();
  });

  it("compartilhando: vira 'Parar de compartilhar' e 'Sair do canal' continua disponível", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ screen: true }));
    mount([state(ME), state("7")]);
    expect(bar().getByRole("button", { name: "Sair do canal" })).toBeInTheDocument();
    await user.click(bar().getByRole("button", { name: "Parar de compartilhar" }));
    await waitFor(() => expect(useVoiceStore.getState().screen).toBe(false));
    expect(bar().queryByRole("button", { name: "Parar de compartilhar" })).not.toBeInTheDocument();
  });

  it("assistindo a tela de outra pessoa: 'Sair da transmissão' para de assistir; compartilhar vence", async () => {
    const user = userEvent.setup();
    fake.audioCapabilities = { strongNoiseSuppression: false, screenWatch: true };
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    expect(bar().getByRole("button", { name: "Sair do canal" })).toBeInTheDocument();
    act(() => useVoiceStore.setState({ screen: true }));
    expect(bar().getByRole("button", { name: "Parar de compartilhar" })).toBeInTheDocument();
    expect(bar().queryByRole("button", { name: "Sair da transmissão" })).not.toBeInTheDocument();
    act(() => useVoiceStore.setState({ screen: false }));
    await user.click(bar().getByRole("button", { name: "Sair da transmissão" }));
    expect(fake.watches).toContainEqual(["7", false]);
  });

  it("com as capacidades do desktop nativo também vira 'Sair da transmissão'; sem a capacidade fica 'Sair do canal'", async () => {
    const user = userEvent.setup();
    const native = new NativeVoiceEngine({
      invoke: vi.fn(),
      createChannel: vi.fn(),
      pickScreenSource: vi.fn(),
    } as never);
    fake.audioCapabilities = native.audioCapabilities;
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await user.click(bar().getByRole("button", { name: "Sair da transmissão" }));
    expect(fake.watches).toContainEqual(["7", false]);
  });

  it("engine sem 'screenWatch' (assina tudo) não mostra 'Sair da transmissão'", () => {
    fake.audioCapabilities = { strongNoiseSuppression: false };
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    expect(bar().queryByRole("button", { name: "Sair da transmissão" })).not.toBeInTheDocument();
    expect(bar().getByRole("button", { name: "Sair do canal" })).toBeInTheDocument();
  });
});

describe("faixa de participantes recolhível", () => {
  const focusScreen = async () => {
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    fireEvent.click(screen.getByRole("button", { name: "Destacar tela de Bia" }));
  };

  it("sem tile em foco não há botão de recolher", () => {
    mount([state(ME), state("7")]);
    expect(screen.queryByTestId("strip-toggle")).not.toBeInTheDocument();
  });

  it("recolhe e expande a faixa, com aria-expanded, rótulo e inert, e lembra a escolha", async () => {
    const user = userEvent.setup();
    await focusScreen();
    const toggle = screen.getByTestId("strip-toggle");
    const strip = screen.getByTestId("participants-strip");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Ocultar participantes");
    expect(strip).not.toHaveAttribute("inert");
    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName("Mostrar participantes");
    expect(strip).toHaveAttribute("inert");
    expect(strip).toHaveAttribute("aria-hidden", "true");
    expect(localStorage.getItem("spook:voice-strip-collapsed")).toBe("1");
    await user.click(toggle);
    expect(strip).not.toHaveAttribute("inert");
    expect(localStorage.getItem("spook:voice-strip-collapsed")).toBe("0");
  });

  it("começa recolhida se a escolha foi lembrada e a tecla P alterna", async () => {
    const user = userEvent.setup();
    localStorage.setItem("spook:voice-strip-collapsed", "1");
    await focusScreen();
    expect(screen.getByTestId("strip-toggle")).toHaveAttribute("aria-expanded", "false");
    screen.getByTestId("strip-toggle").focus();
    await user.keyboard("p");
    expect(screen.getByTestId("strip-toggle")).toHaveAttribute("aria-expanded", "true");
  });

  it("recolhida, a fala de quem está na faixa aparece no botão", async () => {
    const user = userEvent.setup();
    await focusScreen();
    await user.click(screen.getByTestId("strip-toggle"));
    expect(screen.getByTestId("strip-toggle")).not.toHaveAttribute("data-speaking");
    act(() => useVoiceStore.setState({ speaking: new Set([ME]) }));
    expect(screen.getByTestId("strip-toggle")).toHaveAttribute("data-speaking");
  });
});

describe("pedido de foco ('Assistir transmissão')", () => {
  const request = (userId: string, ageMs = 0) =>
    useVoiceStore.setState({
      focusRequest: { userId, source: "screen", at: Date.now() - ageMs, nonce: 1 },
    });

  it("se a tela já está lá, põe em foco e consome o pedido", () => {
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    act(() => request("7"));
    expect(screen.getByRole("list", { name: "Em destaque" })).toBeInTheDocument();
    expect(useVoiceStore.getState().focusRequest).toBeNull();
  });

  it("espera a tela chegar e então foca (a sala ainda estava conectando)", () => {
    mount([state(ME), state("7", { self_screen: true })]);
    act(() => request("7"));
    expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
    expect(useVoiceStore.getState().focusRequest).not.toBeNull();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    expect(screen.getByRole("list", { name: "Em destaque" })).toBeInTheDocument();
    expect(useVoiceStore.getState().focusRequest).toBeNull();
  });

  it("não foca a câmera nem a tela de outra pessoa", () => {
    act(() =>
      useVoiceStore.setState({
        videoTracks: [videoTrack("t1", "8", "screen").info, videoTrack("t2", "7", "camera").info],
      }),
    );
    mount([state(ME), state("7", { self_video: true }), state("8", { self_screen: true })]);
    act(() => request("7"));
    expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
  });

  it("desiste depois de 10 s sem a tela chegar (e não foca se ela chegar tarde)", () => {
    vi.useFakeTimers();
    try {
      mount([state(ME), state("7", { self_screen: true })]);
      act(() => request("7"));
      act(() => void vi.advanceTimersByTime(10_001));
      expect(useVoiceStore.getState().focusRequest).toBeNull();
      act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
      expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("pedido que já nasceu vencido (palco montado tarde) é descartado e não foca depois", () => {
    mount([state(ME), state("7", { self_screen: true })]);
    act(() => request("7", 11_000));
    expect(useVoiceStore.getState().focusRequest).toBeNull();
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    expect(screen.queryByRole("list", { name: "Em destaque" })).not.toBeInTheDocument();
  });
});

describe("menu do tile: Picture-in-Picture", () => {
  const openMenu = async (user: ReturnType<typeof userEvent.setup>, name = "Tela de Bia") => {
    await user.click(screen.getByRole("button", { name: `Opções de ${name}` }));
  };

  it("a janela flutuante só existe em vídeo de outra pessoa, quando a engine declara a capacidade", async () => {
    const user = userEvent.setup();
    act(() =>
      useVoiceStore.setState({
        videoTracks: [
          videoTrack("t1", "7", "screen").info,
          videoTrack("t2", ME, "camera", true).info,
        ],
      }),
    );
    mount([state(ME, { self_video: true }), state("7", { self_screen: true })]);
    await openMenu(user, "Tela de Bia");
    expect(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await openMenu(user, "Ana"); // a prévia local não
    expect(screen.queryByRole("menuitemcheckbox", { name: /Janela flutuante/ })).toBeNull();
  });

  it("navegador sem suporte: o item não aparece, mas a tela cheia continua", async () => {
    const user = userEvent.setup();
    fake.audioCapabilities = { strongNoiseSuppression: false, pictureInPicture: false };
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await openMenu(user);
    expect(screen.queryByRole("menuitemcheckbox", { name: /Janela flutuante/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Tela cheia" })).toBeInTheDocument();
  });

  it("abre a janela flutuante com um <video> próprio e fecha ao escolher de novo", async () => {
    const user = userEvent.setup();
    const joinMod = await import("../pip");
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ }));
    await waitFor(() => expect(requested).toHaveLength(1));
    expect(screen.getByTestId("video-tile").querySelector("video")).not.toBe(requested[0]);
    await waitFor(() => expect(joinMod.isPictureInPictureActive("t1")).toBe(true));
    await openMenu(user);
    expect(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ })).toBeChecked();
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ }));
    await waitFor(() => expect(document.exitPictureInPicture).toHaveBeenCalled());
  });

  it("a janela fecha sozinha quando a faixa termina ou a chamada acaba", async () => {
    const user = userEvent.setup();
    const t = videoTrack("t1", "7", "camera");
    act(() => useVoiceStore.setState({ videoTracks: [t.info] }));
    mount([state(ME), state("7", { self_video: true })]);
    await openMenu(user, "Bia");
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ }));
    await waitFor(() => expect(requested).toHaveLength(1));
    act(() => useVoiceStore.setState({ videoTracks: [] }));
    await waitFor(() => expect(document.exitPictureInPicture).toHaveBeenCalled());
    expect(t.detached).toContain("t1");
  });

  it("o navegador recusar vira um aviso, sem quebrar", async () => {
    const user = userEvent.setup();
    HTMLVideoElement.prototype.requestPictureInPicture = vi.fn(async () => {
      throw new Error("recusou");
    });
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ }));
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith(expect.stringMatching(/janela flutuante/)),
    );
  });

  it("fonte que não é <video> (canvas): não abre e avisa", async () => {
    const user = userEvent.setup();
    act(() => useVoiceStore.setState({ videoTracks: [fake.videoTrack("c1", "7", "screen")] }));
    mount([state(ME), state("7", { self_screen: true })]);
    await openMenu(user);
    await user.click(screen.getByRole("menuitemcheckbox", { name: /Janela flutuante/ }));
    await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    expect(requested).toHaveLength(0);
  });
});

describe("menu do tile: volume por pessoa", () => {
  it("abre o painel de volume (voz e tela) e silenciar só para mim", async () => {
    const user = userEvent.setup();
    fake.audioCapabilities = { strongNoiseSuppression: false, participantVolume: { max: 1 } };
    const { joinVoice } = await import("../controller");
    await joinVoice({ channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: true });
    const sharing = state("7", { self_screen: true });
    useVoiceStatesStore.getState().apply(sharing);
    act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
    mount([state(ME), sharing]);
    await user.click(screen.getByRole("button", { name: "Opções de Tela de Bia" }));
    await user.click(screen.getByRole("menuitem", { name: "Volume de Bia" }));
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
  });

  it("clique direito no tile abre o menu", async () => {
    mount([state(ME), state("7")]);
    fireEvent.contextMenu(screen.getByLabelText("Bia"));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });
});

describe("barra de controles", () => {
  it("tem microfone, câmera, tela, dispositivos e o botão vermelho de sair", () => {
    mount([state(ME), state("7")]);
    const bar = screen.getByRole("toolbar", { name: "Controles do palco" });
    for (const name of [
      "Silenciar microfone",
      "Ligar câmera",
      "Compartilhar tela",
      "Dispositivos",
      "Sair do canal",
    ])
      expect(within(bar).getByRole("button", { name })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Sair do canal" })).toHaveClass(
      "bg-destructive",
    );
  });

  it("mudo: o botão fica marcado e a tecla M alterna", async () => {
    const user = userEvent.setup();
    const { joinVoice } = await import("../controller");
    await joinVoice({ channelId: "c1", guildId: "g1", channelName: "Geral", canSpeak: true });
    mount([state(ME), state("7")]);
    const bar = screen.getByRole("toolbar");
    await user.click(within(bar).getByRole("button", { name: "Silenciar microfone" }));
    expect(within(bar).getByRole("button", { name: "Ativar microfone" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    within(bar).getByRole("button", { name: "Ativar microfone" }).focus();
    await user.keyboard("m");
    await waitFor(() =>
      expect(within(bar).getByRole("button", { name: "Silenciar microfone" })).toBeInTheDocument(),
    );
  });

  it("sem permissão de vídeo, câmera e tela ficam desabilitadas com o motivo", async () => {
    mount([state(ME)], {
      guildPermissions: Permission.VIEW_CHANNEL | Permission.CONNECT | Permission.SPEAK,
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Ligar câmera" })).toBeDisabled(),
    );
    const cam = screen.getByRole("button", { name: "Ligar câmera" });
    expect(cam).toHaveAttribute("title", expect.stringMatching(/permissão para usar vídeo/));
  });

  describe("auto-ocultar", () => {
    const bar = () => screen.getByTestId("stage-controls");
    // O auto-ocultar só vale em tela cheia ou com uma tela em foco: estes testes entram em tela cheia.
    const goFullscreen = () => {
      const stage = screen.getByRole("region", { name: "Vídeo da chamada" });
      Object.defineProperty(document, "fullscreenElement", {
        configurable: true,
        get: () => stage,
      });
      act(() => void document.dispatchEvent(new Event("fullscreenchange")));
    };
    afterEach(() => {
      Reflect.deleteProperty(document, "fullscreenElement");
    });

    it("fora da tela cheia e sem tela em foco, a barra não some", () => {
      vi.useFakeTimers();
      mount([state(ME), state("7")]);
      act(() => void vi.advanceTimersByTime(10_000));
      expect(bar()).toHaveAttribute("data-visible", "true");
      expect(bar()).not.toHaveAttribute("inert");
    });

    it("com uma tela em foco (fora da tela cheia), a barra some e fica inerte; o mouse a traz de volta", () => {
      vi.useFakeTimers();
      act(() => useVoiceStore.setState({ videoTracks: [videoTrack("t1", "7", "screen").info] }));
      mount([state(ME), state("7", { self_screen: true })]);
      fireEvent.click(screen.getByRole("button", { name: "Destacar tela de Bia" }));
      act(() => void vi.advanceTimersByTime(3100));
      expect(bar()).toHaveAttribute("data-visible", "false");
      expect(bar()).toHaveAttribute("inert");
      expect(bar()).toHaveAttribute("aria-hidden", "true");
      fireEvent.pointerMove(screen.getByRole("region", { name: "Vídeo da chamada" }), {
        pointerType: "mouse",
      });
      expect(bar()).toHaveAttribute("data-visible", "true");
      expect(bar()).not.toHaveAttribute("inert");
      expect(bar()).not.toHaveAttribute("aria-hidden");
    });

    it("some após 3 s sem movimento e volta com o mouse", () => {
      vi.useFakeTimers();
      mount([state(ME), state("7")]);
      goFullscreen();
      expect(bar()).toHaveAttribute("data-visible", "true");
      act(() => void vi.advanceTimersByTime(2900));
      expect(bar()).toHaveAttribute("data-visible", "true");
      act(() => void vi.advanceTimersByTime(200));
      expect(bar()).toHaveAttribute("data-visible", "false");
      fireEvent.pointerMove(screen.getByRole("region", { name: "Vídeo da chamada" }), {
        pointerType: "mouse",
      });
      expect(bar()).toHaveAttribute("data-visible", "true");
      act(() => void vi.advanceTimersByTime(3100));
      expect(bar()).toHaveAttribute("data-visible", "false");
    });

    it("com o mouse sobre a barra, ela não some", () => {
      vi.useFakeTimers();
      mount([state(ME), state("7")]);
      goFullscreen();
      fireEvent.pointerEnter(bar(), { pointerType: "mouse" });
      act(() => void vi.advanceTimersByTime(10_000));
      expect(bar()).toHaveAttribute("data-visible", "true");
      fireEvent.pointerLeave(bar(), { pointerType: "mouse" });
      act(() => void vi.advanceTimersByTime(3100));
      expect(bar()).toHaveAttribute("data-visible", "false");
    });

    it("foco por teclado num controle mantém a barra visível", () => {
      vi.useFakeTimers();
      mount([state(ME), state("7")]);
      const mic = screen.getByRole("button", { name: "Silenciar microfone" });
      // jsdom não implementa :focus-visible de verdade
      const real = mic.matches.bind(mic);
      mic.matches = (sel: string) => (sel === ":focus-visible" ? true : real(sel));
      act(() => mic.focus());
      act(() => void vi.advanceTimersByTime(10_000));
      expect(bar()).toHaveAttribute("data-visible", "true");
    });

    it("menu aberto mantém a barra visível", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      mount([state(ME), state("7")]);
      fireEvent.contextMenu(screen.getByLabelText("Bia"));
      await screen.findByRole("menu");
      act(() => void vi.advanceTimersByTime(10_000));
      expect(bar()).toHaveAttribute("data-visible", "true");
    });

    it("em toque, tocar no palco alterna a barra (sem temporizador)", () => {
      vi.useFakeTimers();
      mount([state(ME), state("7")]);
      goFullscreen();
      const stage = screen.getByRole("region", { name: "Vídeo da chamada" });
      fireEvent.pointerDown(stage, { pointerType: "touch" });
      fireEvent.click(stage);
      expect(bar()).toHaveAttribute("data-visible", "false");
      fireEvent.pointerDown(stage, { pointerType: "touch" });
      fireEvent.click(stage);
      expect(bar()).toHaveAttribute("data-visible", "true");
      act(() => void vi.advanceTimersByTime(10_000));
      expect(bar()).toHaveAttribute("data-visible", "true");
    });

    it("conectando, a barra fica visível", () => {
      vi.useFakeTimers();
      useVoiceStore.setState({ status: "connecting" });
      mount([state(ME)]);
      act(() => void vi.advanceTimersByTime(10_000));
      expect(bar()).toHaveAttribute("data-visible", "true");
    });
  });
});

describe("estados", () => {
  it("conectando e reconectando avisam; áudio bloqueado oferece 'Ativar áudio'", async () => {
    useVoiceStore.setState({ status: "connecting" });
    const view = mount([state(ME)]);
    expect(screen.getByText("Conectando à chamada…")).toBeInTheDocument();
    act(() => useVoiceStore.setState({ status: "reconnecting" }));
    expect(screen.getByText("Reconectando à chamada…")).toBeInTheDocument();
    act(() => useVoiceStore.setState({ status: "connected", audioBlocked: true }));
    expect(screen.getByRole("button", { name: "Ativar áudio" })).toBeInTheDocument();
    view.unmount();
  });

  it("falha de microfone/câmera aparece como aviso persistente e pode ser dispensado", async () => {
    const user = userEvent.setup();
    mount([state(ME)]);
    act(() => useVoiceStore.setState({ mediaIssue: "O navegador bloqueou o microfone." }));
    expect(screen.getByRole("alert")).toHaveTextContent("O navegador bloqueou o microfone.");
    await user.click(screen.getByRole("button", { name: "Dispensar aviso" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("sem permissão para falar, o meu tile mostra o ícone com o motivo", () => {
    mount([state(ME)], { guildPermissions: Permission.VIEW_CHANNEL | Permission.CONNECT });
    useVoiceStore.setState({ selfMute: true });
    expect(
      within(screen.getByLabelText("Ana")).queryByRole("img", {
        name: /Microfone silenciado|Sem permissão para falar/,
      }),
    ).toBeDefined();
  });
});
