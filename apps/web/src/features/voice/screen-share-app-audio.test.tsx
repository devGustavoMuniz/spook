import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLimits } from "@/features/nitro/limits-store";
import { PLAN_LIMITS } from "@/features/nitro/plans";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import {
  buildAppAudioOptions,
  buildRows,
  clampPercent,
  isSelfApp,
  loadAppAudioPrefs,
  saveAppAudioPrefs,
} from "./app-audio";
import { resetVoiceController } from "./controller";
import { saveScreenSharePrefs } from "./devices";
import type { AudioAppsResult } from "./engine";
import { setVoiceEngineFactory } from "./engine-provider";
import { ScreenShareDialog } from "./screen-share-dialog";

const render = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["/api/me/plan"], {
    tier: "free",
    expires_at: null,
    source: null,
    limits: PLAN_LIMITS.free,
  });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

const APPS: AudioAppsResult = {
  supported: true,
  apps: [
    { id: "chrome.exe", name: "Chrome", exe: "chrome.exe", playing: false },
    { id: "spotify.exe", name: "Spotify", exe: "spotify.exe", playing: true },
    { id: "spook.exe", name: "Spook", exe: "Spook.exe", playing: true },
  ],
};

function desktopEngine(audioApps: AudioAppsResult = APPS) {
  const eng = new FakeVoiceEngine();
  eng.audioCapabilities = {
    strongNoiseSuppression: true,
    screenShareAudio: false,
    screenShareAppAudio: true,
    screenSharePreview: false,
  };
  eng.audioApps = audioApps;
  setVoiceEngineFactory(() => eng);
  return eng;
}

const openSection = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("button", { name: "Configurações avançadas" }));
};

const enableAudio = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(await screen.findByRole("switch", { name: /Áudio de aplicativos/ }));
};

const pickApps = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole("radio", { name: "Aplicativos selecionados" }));

beforeEach(() => {
  localStorage.clear();
  resetLimits();
  setVoiceEngineFactory(() => new FakeVoiceEngine());
});
afterEach(() => {
  vi.useRealTimers();
  setVoiceEngineFactory(null);
  resetVoiceController();
});

describe("Áudio de aplicativos: diálogo de compartilhar tela", () => {
  it("na web (sem a capacidade) a seção não existe e o diálogo segue como antes", async () => {
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await screen.findByRole("switch", { name: /Incluir áudio/ });
    expect(screen.queryByRole("button", { name: "Configurações avançadas" })).toBeNull();
  });

  it("no desktop a seção vem FECHADA, o interruptor simples some e não há o aviso de 'só a imagem'", async () => {
    desktopEngine();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const head = await screen.findByRole("button", { name: "Configurações avançadas" });
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("switch", { name: /Incluir áudio/ })).toBeNull();
    expect(screen.queryByText(/só a imagem/)).toBeNull();
    expect(screen.queryByRole("switch", { name: /Áudio de aplicativos/ })).toBeNull();
  });

  it("abre pelo teclado; o interruptor começa desligado e liga os modos", async () => {
    desktopEngine();
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const head = await screen.findByRole("button", { name: "Configurações avançadas" });
    head.focus();
    await user.keyboard("{Enter}");
    expect(head).toHaveAttribute("aria-expanded", "true");
    const sw = await screen.findByRole("switch", { name: /Áudio de aplicativos/ });
    expect(sw).not.toBeChecked();
    expect(screen.queryByRole("radiogroup")).toBeNull();
    await user.click(sw);
    expect(screen.getByRole("radiogroup", { name: "O que compartilhar" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Todo o sistema" })).toBeChecked();
  });

  it("modo 'Todo o sistema' confirma com áudio e master 100, sem aplicativos", async () => {
    desktopEngine();
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await openSection(user);
    await enableAudio(user);
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: true,
      appAudio: { mode: "system", master: 100, apps: [] },
    });
  });

  it("lista os aplicativos com som, SEM o Spook, e mostra os que tocam primeiro", async () => {
    desktopEngine();
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    const list = await screen.findByRole("list", { name: "Aplicativos com áudio" });
    await within(list).findByRole("checkbox", { name: "Spotify" });
    const names = within(list)
      .getAllByRole("checkbox")
      .map((c) => (c as HTMLInputElement).labels?.[0]?.textContent);
    expect(names).toEqual(["Spotify", "Chrome"]);
    expect(within(list).queryByText("Spook")).toBeNull();
    expect(screen.getByText("Volume master")).toBeInTheDocument();
  });

  it("marcar um aplicativo e mexer nos volumes vai para a confirmação (por executável)", async () => {
    desktopEngine();
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    await user.click(await screen.findByRole("checkbox", { name: "Spotify" }));
    fireEvent.change(screen.getByRole("slider", { name: "Volume de Spotify" }), {
      target: { value: "40" },
    });
    fireEvent.change(screen.getByRole("slider", { name: "Volume master" }), {
      target: { value: "70" },
    });
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: true,
      appAudio: { mode: "apps", master: 70, apps: [{ exe: "spotify.exe", volume: 40 }] },
    });
  });

  it("lembra modo, master, volumes e apps marcados (por executável) ao reabrir", async () => {
    desktopEngine();
    const user = userEvent.setup();
    const first = render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    await user.click(await screen.findByRole("checkbox", { name: "Chrome" }));
    fireEvent.change(screen.getByRole("slider", { name: "Volume de Chrome" }), {
      target: { value: "25" },
    });
    expect(loadAppAudioPrefs()).toMatchObject({
      mode: "apps",
      apps: { "chrome.exe": { selected: true, volume: 25 } },
    });
    first.unmount();
    resetVoiceController();

    // O interruptor "áudio ligado" é lembrado pelo fluxo de compartilhar (controlador), não por este diálogo.
    saveScreenSharePrefs({ audio: true });
    // Outra abertura: o Chrome fechou, mas continua marcado (aparece como "não está tocando").
    desktopEngine({ supported: true, apps: [APPS.apps[1] as never] });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await screen.findByRole("radiogroup", { name: "O que compartilhar" });
    expect(screen.getByRole("radio", { name: "Aplicativos selecionados" })).toBeChecked();
    const chrome = await screen.findByRole("checkbox", { name: "Chrome" });
    expect(chrome).toBeChecked();
    expect(screen.getByRole("slider", { name: "Volume de Chrome" })).toHaveValue("25");
    expect(screen.getByText("não está tocando")).toBeInTheDocument();
  });

  it("estado vazio e botão de atualizar", async () => {
    const eng = desktopEngine({ supported: true, apps: [] });
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    expect(await screen.findByText("Nenhum aplicativo com áudio agora")).toBeInTheDocument();
    const before = eng.audioAppsCalls;
    eng.audioApps = APPS;
    await user.click(screen.getByRole("button", { name: "Atualizar lista" }));
    expect(await screen.findByRole("checkbox", { name: "Spotify" })).toBeInTheDocument();
    expect(eng.audioAppsCalls).toBeGreaterThan(before);
  });

  it("atualiza a lista sozinha enquanto está aberta (a cada 3 s)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const eng = desktopEngine({ supported: true, apps: [] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    await screen.findByText("Nenhum aplicativo com áudio agora");
    eng.audioApps = APPS;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3100);
    });
    expect(await screen.findByRole("checkbox", { name: "Spotify" })).toBeInTheDocument();
  });

  it("sem aplicativo marcado explica que só a imagem vai", async () => {
    desktopEngine();
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    expect(await screen.findByText(/Marque ao menos um aplicativo/)).toBeInTheDocument();
    await user.click(screen.getByRole("checkbox", { name: "Spotify" }));
    expect(screen.queryByText(/Marque ao menos um aplicativo/)).toBeNull();
    expect(screen.getByText(/nunca aparece nesta lista/)).toBeInTheDocument();
  });

  it("plataforma/versão sem suporte: aviso claro, interruptor desligado e confirma sem áudio", async () => {
    desktopEngine({ supported: false, reason: "windows-version", apps: [] });
    saveAppAudioPrefs({ mode: "apps", master: 100, apps: {} });
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await openSection(user);
    expect(await screen.findByText(/Windows 10 versão 2004/)).toBeInTheDocument();
    const sw = screen.getByRole("switch", { name: /Áudio de aplicativos/ });
    expect(sw).toBeDisabled();
    expect(sw).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false });
  });

  it("macOS/Linux: explica que só existe no Windows", async () => {
    desktopEngine({ supported: false, reason: "platform", apps: [] });
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    expect(await screen.findByText(/só existe no Windows 10 e 11/)).toBeInTheDocument();
  });

  it("falha ao listar: mensagem e nova tentativa pelo botão; o modo 'sistema' continua disponível", async () => {
    const eng = desktopEngine();
    eng.failAudioApps = true;
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    expect(screen.getByRole("switch", { name: /Áudio de aplicativos/ })).not.toBeDisabled();
    await pickApps(user);
    expect(await screen.findByText(/Não foi possível listar/)).toBeInTheDocument();
    eng.failAudioApps = false;
    await user.click(screen.getByRole("button", { name: "Atualizar lista" }));
    expect(await screen.findByRole("checkbox", { name: "Spotify" })).toBeInTheDocument();
  });

  it("layout estreito (390 px): sem larguras fixas, nomes truncam e a lista rola na vertical", async () => {
    desktopEngine();
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await openSection(user);
    await enableAudio(user);
    await pickApps(user);
    const list = await screen.findByRole("list", { name: "Aplicativos com áudio" });
    expect(list.className).toContain("overflow-y-auto");
    expect(list.className).not.toContain("overflow-x");
    const label = (await within(list).findByText("Spotify")) as HTMLElement;
    expect(label.className).toContain("truncate");
    expect(label.className).toContain("min-w-0");
    const slider = screen.getByRole("slider", { name: "Volume master" });
    expect(slider.className).toContain("min-w-0");
    await waitFor(() => expect(document.body.innerHTML).not.toMatch(/w-\[\d+px\]/));
  });
});

describe("app-audio.ts (lógica pura)", () => {
  it("normaliza executáveis e limita porcentagens", () => {
    expect(clampPercent(150)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(clampPercent(Number.NaN)).toBe(100);
    expect(clampPercent("x", 7)).toBe(7);
  });

  it("o Spook é reconhecido pelo executável, qualquer caixa ou caminho", () => {
    expect(isSelfApp("Spook.exe")).toBe(true);
    expect(isSelfApp("C:\\Apps\\spook-desktop.exe")).toBe(true);
    expect(isSelfApp("spotify.exe")).toBe(false);
  });

  it("preferências corrompidas viram o padrão", () => {
    localStorage.setItem("spook:voice-screen-app-audio", "{não é json");
    expect(loadAppAudioPrefs()).toEqual({ mode: "system", master: 100, apps: {} });
    localStorage.setItem(
      "spook:voice-screen-app-audio",
      JSON.stringify({
        mode: "apps",
        master: 500,
        apps: { "A.EXE": { selected: true, volume: "x" } },
      }),
    );
    expect(loadAppAudioPrefs()).toEqual({
      mode: "apps",
      master: 100,
      apps: { "a.exe": { selected: true, volume: 100 } },
    });
  });

  it("localStorage indisponível não derruba (salvar e carregar)", () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    expect(() => saveAppAudioPrefs({ mode: "apps", master: 10, apps: {} })).not.toThrow();
    expect(loadAppAudioPrefs().mode).toBe("system");
    spy.mockRestore();
    get.mockRestore();
  });

  it("o parâmetro nunca inclui o Spook, mesmo marcado nas preferências", () => {
    const opts = buildAppAudioOptions({
      mode: "apps",
      master: 90,
      apps: {
        "spook.exe": { selected: true, volume: 100 },
        "spotify.exe": { selected: true, volume: 30 },
        "chrome.exe": { selected: false, volume: 100 },
      },
    });
    expect(opts).toEqual({ mode: "apps", master: 90, apps: [{ exe: "spotify.exe", volume: 30 }] });
    const rows = buildRows([], {
      mode: "apps",
      master: 100,
      apps: { "spook.exe": { selected: true, volume: 100 } },
    });
    expect(rows).toEqual([]);
  });

  it("junta executáveis repetidos da lista em uma linha", () => {
    const rows = buildRows(
      [
        { id: "a", name: "A", exe: "A.exe", playing: false },
        { id: "a", name: "A", exe: "a.exe", playing: true },
      ],
      { mode: "apps", master: 100, apps: {} },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ exe: "a.exe", playing: true, present: true });
  });
});
