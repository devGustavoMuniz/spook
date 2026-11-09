import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render as rtlRender, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLimits } from "@/features/nitro/limits-store";
import { PLAN_LIMITS, type PlanTier } from "@/features/nitro/plans";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { saveDevicePref, saveScreenSharePrefs } from "./devices";
import { setVoiceEngineFactory } from "./engine-provider";
import { saveScreenChoice } from "./screen-quality";
import { ScreenShareDialog } from "./screen-share-dialog";

// O diálogo lê o plano (GET /api/me/plan): cada render tem o seu cache.
const render = (ui: React.ReactElement) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(["/api/me/plan"], {
    tier,
    expires_at: null,
    source: tier === "free" ? null : "admin",
    limits: PLAN_LIMITS[tier],
  });
  return rtlRender(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
};

let tier: PlanTier = "free";
const asTier = (t: PlanTier) => {
  tier = t;
};

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  resetLimits();
  asTier("free");
  setVoiceEngineFactory(() => new FakeVoiceEngine());
});
afterEach(() => {
  setVoiceEngineFactory(null);
  resetVoiceController();
});

describe("ScreenShareDialog", () => {
  it("o áudio começa desligado e a orientação sobre eco/aba/fones aparece", async () => {
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("switch", { name: /Incluir áudio/ })).not.toBeChecked();
    expect(screen.getByText(/ouvirão de volta \(eco\)/)).toBeInTheDocument();
    expect(screen.getByText(/compartilhe uma/)).toHaveTextContent(/aba/);
    expect(screen.getByText(/use fones de ouvido/)).toBeInTheDocument();
  });

  it("confirma sem áudio por padrão", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false, preview: true });
  });

  it("incluir áudio é uma escolha explícita", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("switch", { name: /Incluir áudio/ }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: true, preview: true });
  });

  it("lembra a última escolha", async () => {
    saveScreenSharePrefs({ audio: true });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("switch", { name: /Incluir áudio/ })).toBeChecked();
  });

  it("áudio ligado com saída que parece caixa de som: aviso extra de eco", async () => {
    const user = userEvent.setup();
    const eng = new FakeVoiceEngine();
    eng.devices.audiooutput = [{ id: "spk", label: "Alto-falantes (Realtek)" }];
    setVoiceEngineFactory(() => eng);
    saveDevicePref("audiooutput", "spk");
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const toggle = await screen.findByRole("switch", { name: /Incluir áudio/ });
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(toggle);
    expect(await screen.findByRole("status")).toHaveTextContent(/caixa de som/);
  });

  it("com fones (ou saída desconhecida) não mostra o aviso extra", async () => {
    const eng = new FakeVoiceEngine();
    eng.devices.audiooutput = [{ id: "fone", label: "Fones de ouvido Bluetooth" }];
    setVoiceEngineFactory(() => eng);
    saveDevicePref("audiooutput", "fone");
    saveScreenSharePrefs({ audio: true });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await screen.findByRole("switch", { name: /Incluir áudio/ });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });

  it("no app de computador não há opção de áudio: explica que só a imagem vai e confirma sem áudio", async () => {
    const user = userEvent.setup();
    const eng = new FakeVoiceEngine();
    eng.audioCapabilities = { strongNoiseSuppression: true, screenShareAudio: false };
    setVoiceEngineFactory(() => eng);
    saveScreenSharePrefs({ audio: true });
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    expect(await screen.findByText(/só a imagem/)).toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: /Incluir áudio/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false, preview: true });
  });
});

describe("ScreenShareDialog: qualidade", () => {
  beforeEach(() => asTier("nitro_plus")); // aqui o plano não tranca nada: testa a tabela e a persistência
  function withQuality(extra: { screenSharePreview?: boolean } = {}) {
    const eng = new FakeVoiceEngine();
    eng.audioCapabilities = { strongNoiseSuppression: false, screenShareQuality: true, ...extra };
    setVoiceEngineFactory(() => eng);
  }

  it("engine sem a capacidade: sem seletores e explica com honestidade", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    expect(await screen.findByText(/qualidade da imagem é automática/)).toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Resolução" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false, preview: true }); // sem `quality`
  });

  it("é um bloco simples: Resolução, Taxa de quadros, áudio e prévia; sem presets nem opções avançadas", async () => {
    withQuality();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const res = await screen.findByRole("radiogroup", { name: "Resolução" });
    expect(
      within(res)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["720", "1080", "1440"]);
    const fps = screen.getByRole("radiogroup", { name: "Taxa de quadros" });
    expect(
      within(fps)
        .getAllByRole("radio")
        .map((r) => r.getAttribute("value")),
    ).toEqual(["15", "30", "60"]);
    expect(screen.getByRole("switch", { name: /Incluir áudio/ })).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Mostrar prévia para o canal" })).toBeChecked();
    expect(screen.queryByText(/Nitidez|Equilibrado|Fluidez|Opções avançadas/)).toBeNull();
    expect(screen.queryByRole("radio", { name: /Priorizar/ })).toBeNull();
  });

  it("o padrão é 1080p/30 fps, sem aviso de custo, e confirma com a prioridade derivada", async () => {
    withQuality();
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    expect(await screen.findByRole("radio", { name: "1080p" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "30 fps" })).toBeChecked();
    expect(screen.getByText(/Banda de subida: até 5 Mbps/)).toBeInTheDocument();
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: false,
      quality: { height: 1080, fps: 30, priority: "motion" },
      preview: true,
    });
  });

  it("fps até 15 vira prioridade 'detail'; 1440p/60 fps mostram o aviso de custo e a estimativa nova", async () => {
    withQuality();
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("radio", { name: "1440p" }));
    await user.click(screen.getByRole("radio", { name: "15 fps" }));
    expect(screen.getByText(/até 4 Mbps/)).toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "60 fps" }));
    expect(screen.getByText(/até 12 Mbps/)).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      /processador e internet de quem transmite/,
    );
    await user.click(screen.getByRole("radio", { name: "15 fps" }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: false,
      quality: { height: 1440, fps: 15, priority: "detail" },
      preview: true,
    });
  });

  it("lembra a última escolha de resolução e fps", async () => {
    withQuality();
    saveScreenChoice({ height: 720, fps: 60 });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("radio", { name: "720p" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "60 fps" })).toBeChecked();
  });

  it("migra a chave antiga de preset: mesma resolução e fps, sem quebrar", async () => {
    withQuality();
    localStorage.setItem(
      "spook:voice-screen-quality",
      JSON.stringify({ height: 1440, fps: 30, priority: "detail", maxBitrateKbps: 6000 }),
    );
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("radio", { name: "1440p" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "30 fps" })).toBeChecked();
  });

  it("os seletores se operam pelo teclado (setas)", async () => {
    withQuality();
    const user = userEvent.setup();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const r1080 = await screen.findByRole("radio", { name: "1080p" });
    r1080.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "1440p" })).toBeChecked();
  });
});

describe("ScreenShareDialog: prévia para o canal", () => {
  it("vem ligada, explica a privacidade e a escolha é lembrada para a próxima vez", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const { unmount } = render(
      <ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />,
    );
    const box = await screen.findByRole("checkbox", { name: "Mostrar prévia para o canal" });
    expect(box).toBeChecked();
    expect(box).toHaveAccessibleDescription(
      "Quem está no servidor vê uma miniatura da sua tela antes de entrar na transmissão. Desligue para conteúdo sensível.",
    );
    await user.click(box);
    expect(box).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false, preview: false });
    // A persistência é do controlador (`toggleScreenShare`); o diálogo lê o que ficou salvo.
    saveScreenSharePrefs({ preview: false });
    unmount();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("checkbox", { name: /prévia para o canal/ })).not.toBeChecked();
  });

  it("registro antigo (só com áudio) ganha a prévia ligada", async () => {
    localStorage.setItem("spook:voice-screen-share", JSON.stringify({ audio: true }));
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("checkbox", { name: /prévia para o canal/ })).toBeChecked();
    expect(screen.getByRole("switch", { name: /Incluir áudio/ })).toBeChecked();
  });

  it("no app de computador (sem a capacidade) o campo vem desabilitado, explica e não manda `preview`", async () => {
    const user = userEvent.setup();
    const eng = new FakeVoiceEngine();
    eng.audioCapabilities = {
      strongNoiseSuppression: true,
      screenShareAudio: false,
      screenShareQuality: true,
      screenSharePreview: false,
    };
    setVoiceEngineFactory(() => eng);
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    const box = await screen.findByRole("checkbox", { name: "Mostrar prévia para o canal" });
    expect(box).toBeDisabled();
    expect(box).not.toBeChecked();
    expect(box).toHaveAccessibleDescription("Indisponível no app para computador.");
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({
      audio: false,
      quality: { height: 720, fps: 30, priority: "motion" },
    });
  });
});

describe("ScreenShareDialog: limites do plano", () => {
  beforeEach(() => {
    const eng = new FakeVoiceEngine();
    eng.audioCapabilities = { strongNoiseSuppression: false, screenShareQuality: true };
    setVoiceEngineFactory(() => eng);
  });

  it("grátis: 720p e 30 fps livres; 1080p, 1440p e 60 fps têm cadeado e o padrão salvo é reduzido", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    saveScreenChoice({ height: 1440, fps: 60 }); // preferência de quando havia plano
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    const res = await screen.findByRole("radiogroup", { name: "Resolução" });
    expect(within(res).getByRole("radio", { name: "720p" })).toBeChecked();
    for (const label of ["1080p", "1440p"])
      expect(
        within(res).getByRole("button", { name: new RegExp(`${label}: requer`) }),
      ).toBeInTheDocument();
    const fps = screen.getByRole("radiogroup", { name: "Taxa de quadros" });
    expect(within(fps).getByRole("radio", { name: "30 fps" })).toBeChecked();
    expect(within(fps).getByRole("button", { name: /60 fps: requer Nitro/ })).toBeInTheDocument();
    expect(within(res).getByRole("button", { name: /1440p: requer Nitro\+/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ quality: { height: 720, fps: 30 } });
  });

  it("o cadeado fecha o diálogo e leva à seção Nitro", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<ScreenShareDialog open onOpenChange={onOpenChange} onConfirm={() => {}} />);
    await user.click(await screen.findByRole("button", { name: /1080p: requer Nitro/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(assign).toHaveBeenCalledWith("/settings/nitro");
    vi.unstubAllGlobals();
  });

  it("Nitro: 1080p e 60 fps livres; 1440p ainda trancado (só Nitro+)", async () => {
    asTier("nitro");
    saveScreenChoice({ height: 1080, fps: 60 });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const res = await screen.findByRole("radiogroup", { name: "Resolução" });
    expect(within(res).getByRole("radio", { name: "1080p" })).toBeChecked();
    const fps = screen.getByRole("radiogroup", { name: "Taxa de quadros" });
    expect(within(fps).getByRole("radio", { name: "60 fps" })).toBeChecked();
    expect(within(res).getByRole("button", { name: /1440p: requer Nitro\+/ })).toBeInTheDocument();
  });

  it("Nitro+: nenhuma opção trancada e 1440p/60 fps são enviados", async () => {
    asTier("nitro_plus");
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    saveScreenChoice({ height: 1440, fps: 60 });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    const res = await screen.findByRole("radiogroup", { name: "Resolução" });
    expect(within(res).getByRole("radio", { name: "1440p" })).toBeChecked();
    expect(screen.queryByRole("button", { name: /requer/ })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm.mock.calls[0]?.[0]).toMatchObject({ quality: { height: 1440, fps: 60 } });
  });
});
