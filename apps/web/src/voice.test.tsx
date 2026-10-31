import { Permission } from "@spook/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { resetVoiceController } from "@/features/voice/controller";
import { VoiceMediaError } from "@/features/voice/engine";
import { setVoiceEngineFactory } from "@/features/voice/engine-provider";
import { useVoiceStatesStore, useVoiceStore } from "@/features/voice/store";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { dm, guild, ME, member, recipient } from "@/test/fixtures";
import { connectGateway, serverSends, voiceState } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const VOICE = "g1-voz";
const PATH = "/channels/g1/g1-txt";
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const FULL = BASE | Permission.CONNECT | Permission.SPEAK | Permission.VIDEO;

let fake: FakeVoiceEngine;

beforeEach(() => {
  fake = new FakeVoiceEngine();
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
});

function seedWith(permissions: number) {
  return (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { permissions }));
    s.members.g1 = [member(ME, "ana"), member("50", "bia")];
  };
}

async function open(
  permissions = FULL,
  voice_states = [voiceState("50", VOICE, { self_mute: true })],
) {
  const app = await renderApp(PATH, { signedIn: true, seed: seedWith(permissions) });
  const nav = await screen.findByRole("navigation", { name: "Canais" });
  const sock = await connectGateway(app.state.guilds, "s1", { voice_states });
  return { ...app, sock, nav };
}

const voiceButton = (nav: HTMLElement) =>
  within(nav).getByRole("button", { name: /Geral \(canal de voz/ });

describe("lista de canais de voz", () => {
  it("mostra quem está conectado (READY) com ícone de mudo e acompanha os eventos", async () => {
    const { nav, sock } = await open();
    const list = await within(nav).findByRole("list", { name: "Conectados" });
    expect(within(list).getByText("bia")).toBeInTheDocument();
    expect(within(list).getByRole("img", { name: "Microfone silenciado" })).toBeInTheDocument();

    serverSends(
      sock,
      "VOICE_STATE_UPDATE",
      2,
      voiceState(ME, VOICE, { self_video: true, self_deaf: true }),
    );
    expect(await within(nav).findByText("ana")).toBeInTheDocument();
    expect(within(nav).getByRole("img", { name: "Câmera ligada" })).toBeInTheDocument();
    expect(within(nav).getByRole("img", { name: "Áudio desativado" })).toBeInTheDocument();

    serverSends(sock, "VOICE_STATE_UPDATE", 3, voiceState("50", null));
    await waitFor(() => expect(within(nav).queryByText("bia")).not.toBeInTheDocument());
  });

  it("novo READY (reconexão) zera o mapa e recarrega o snapshot", async () => {
    const { nav, sock, state } = await open();
    await within(nav).findByText("bia");
    act(() => {
      sock.hello();
      sock.dispatch("READY", 1, {
        session_id: "s2",
        user: { id: ME },
        guilds: state.guilds,
        private_channels: [],
        presences: [],
        voice_states: [voiceState("60", VOICE)],
      });
    });
    await waitFor(() => expect(within(nav).queryByText("bia")).not.toBeInTheDocument());
    expect(useVoiceStatesStore.getState().byUser["60"]).toBeDefined();
  });

  it("sem CONNECT o canal fica bloqueado", async () => {
    const { nav } = await open(BASE);
    const btn = within(nav).getByRole("button", { name: /Geral \(canal de voz, sem permissão/ });
    expect(btn).toBeDisabled();
  });
});

describe("entrar e a barra de controle", () => {
  it("clicar no canal pede o token, conecta e mostra a barra persistente", async () => {
    const user = userEvent.setup();
    const { nav, state } = await open();
    await user.click(voiceButton(nav));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    expect(await within(bar).findByText("Voz conectada")).toBeInTheDocument();
    expect(state.voice.tokensFor).toEqual([VOICE]);
    expect(within(bar).getByText("Geral")).toBeInTheDocument();
    // abre o painel do canal (cabeçalho com "Sair do canal")
    expect(await screen.findByRole("button", { name: "Sair do canal" })).toBeInTheDocument();
    expect(fake.mic).toBe(true);
  });

  it("mudo, surdo, câmera, tela e sair", async () => {
    const user = userEvent.setup();
    const { nav, state } = await open();
    await user.click(voiceButton(nav));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");

    await user.click(within(bar).getByRole("button", { name: "Silenciar microfone" }));
    expect(within(bar).getByRole("button", { name: "Ativar microfone" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await waitFor(() =>
      expect(state.voice.stateBodies.at(-1)).toEqual({ self_mute: true, self_deaf: false }),
    );

    await user.click(within(bar).getByRole("button", { name: "Desativar áudio" }));
    expect(fake.deafened).toBe(true);
    await waitFor(() =>
      expect(state.voice.stateBodies.at(-1)).toEqual({ self_mute: true, self_deaf: true }),
    );

    await user.click(within(bar).getByRole("button", { name: "Ligar câmera" }));
    await user.click(within(bar).getByRole("button", { name: "Compartilhar tela" }));
    // o diálogo de compartilhar vem antes do seletor do navegador; o áudio começa desligado
    await user.click(await screen.findByRole("button", { name: "Compartilhar" }));
    await waitFor(() => expect(fake.camera && fake.screen).toBe(true));
    expect(fake.calls).toContain("screen:true:mudo");
    expect(within(bar).getByRole("button", { name: "Desligar câmera" })).toBeInTheDocument();
    expect(
      within(bar).getByRole("button", { name: "Parar de compartilhar a tela" }),
    ).toBeInTheDocument();

    await user.click(within(bar).getByRole("button", { name: "Sair da chamada" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Controles de voz" })).not.toBeInTheDocument(),
    );
    expect(state.voice.leaves).toBe(1);
  });

  it("o indicador de conexão reflete a qualidade e a reconexão", async () => {
    const user = userEvent.setup();
    const { nav } = await open();
    await user.click(voiceButton(nav));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    act(() => fake.fire("link-quality", { quality: "poor" }));
    expect(within(bar).getByRole("img", { name: "Conexão ruim" })).toBeInTheDocument();
    act(() => fake.fire("connection-state", { state: "reconnecting" }));
    expect(within(bar).getByText("Reconectando…")).toBeInTheDocument();
  });

  it("áudio bloqueado pelo navegador mostra o botão de ativar", async () => {
    const user = userEvent.setup();
    const { nav } = await open();
    await user.click(voiceButton(nav));
    await screen.findByText("Voz conectada");
    act(() => fake.fire("audio-blocked", { blocked: true }));
    await user.click(await screen.findByRole("button", { name: /Ativar áudio/ }));
    expect(fake.calls).toContain("resume-audio");
  });

  it("sem SPEAK o microfone fica desabilitado com explicação; sem VIDEO câmera e tela também", async () => {
    const user = userEvent.setup();
    const { nav } = await open(BASE | Permission.CONNECT);
    await user.click(voiceButton(nav));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    const mic = within(bar).getByRole("button", { name: /Silenciar microfone/ });
    expect(mic).toBeDisabled();
    expect(mic).toHaveAttribute("title", "Você não tem permissão para falar neste canal.");
    expect(within(bar).getByRole("button", { name: /Ligar câmera/ })).toBeDisabled();
    expect(within(bar).getByRole("button", { name: /Compartilhar tela/ })).toBeDisabled();
    expect(fake.mic).toBe(false);
    expect(
      await screen.findByText(/Você pode ouvir, mas não tem permissão para falar/),
    ).toBeInTheDocument();
  });
});

describe("erros", () => {
  it("503 (voz desligada) avisa em pt-br e não mostra a barra", async () => {
    const user = userEvent.setup();
    const { nav, state } = await open();
    state.voice.tokenError = { status: 503, detail: "voz indisponível" };
    await user.click(voiceButton(nav));
    expect(await screen.findByText(/A voz está indisponível no momento/)).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Controles de voz" })).not.toBeInTheDocument();
  });

  it("microfone negado pelo navegador: entra mudo com explicação", async () => {
    const user = userEvent.setup();
    fake.failMic = new VoiceMediaError("permission-denied", "microphone");
    const { nav } = await open();
    await user.click(voiceButton(nav));
    expect(await screen.findByText(/O navegador bloqueou o microfone/)).toBeInTheDocument();
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    expect(within(bar).getByRole("button", { name: "Ativar microfone" })).toBeInTheDocument();
  });

  it("seleção de tela cancelada", async () => {
    const user = userEvent.setup();
    const { nav } = await open();
    await user.click(voiceButton(nav));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    fake.failScreen = new VoiceMediaError("cancelled", "screen");
    await user.click(within(bar).getByRole("button", { name: "Compartilhar tela" }));
    await user.click(await screen.findByRole("button", { name: "Compartilhar" }));
    expect(await screen.findByText("Compartilhamento de tela cancelado.")).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Compartilhar tela" })).toBeInTheDocument();
  });

  it("o servidor me tira da sala (perdi CONNECT): barra some e aparece o aviso", async () => {
    const user = userEvent.setup();
    const { nav, sock } = await open();
    await user.click(voiceButton(nav));
    await screen.findByText("Voz conectada");
    serverSends(sock, "VOICE_STATE_UPDATE", 2, voiceState(ME, VOICE)); // webhook de entrada
    serverSends(sock, "VOICE_STATE_UPDATE", 3, voiceState(ME, null)); // removido
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Controles de voz" })).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("Você foi desconectado da chamada de voz.")).toBeInTheDocument();
    expect(fake.state).toBe("disconnected");
  });

  it("queda forçada da sala (evento do LiveKit) também limpa a interface", async () => {
    const user = userEvent.setup();
    const { nav } = await open();
    await user.click(voiceButton(nav));
    await screen.findByText("Voz conectada");
    act(() => fake.drop("removed"));
    await waitFor(() => expect(useVoiceStore.getState().status).toBe("idle"));
  });
});

describe("painel de vídeo", () => {
  it("destaca a tela compartilhada e mostra a câmera numa faixa; clicar troca o destaque", async () => {
    const user = userEvent.setup();
    const { nav } = await open();
    await user.click(voiceButton(nav));
    await screen.findByText("Voz conectada");
    act(() => {
      fake.videoTrack("cam1", "50", "camera");
      fake.videoTrack("scr1", "50", "screen");
    });
    const video = await screen.findByRole("region", { name: "Vídeo da chamada" });
    const tiles = within(video).getAllByTestId("video-tile");
    expect(tiles).toHaveLength(2);
    expect(tiles[0]).toHaveAttribute("data-kind", "screen");
    expect(tiles[0]?.querySelector("canvas[data-track=scr1]")).not.toBeNull(); // a engine desenha como quiser
    await user.click(within(video).getByRole("button", { name: "Destacar câmera de bia" }));
    expect(within(video).getAllByTestId("video-tile")[0]).toHaveAttribute("data-kind", "camera");
    act(() => fake.fire("video-track-removed", { id: "cam1" }));
    await waitFor(() => expect(within(video).getAllByTestId("video-tile")).toHaveLength(1));
  });
});

describe("dispositivos", () => {
  it("o diálogo lista os dispositivos, aplica na chamada e persiste no navegador", async () => {
    const user = userEvent.setup();
    const { nav } = await open();
    await user.click(voiceButton(nav));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    await user.click(within(bar).getByRole("button", { name: "Dispositivos" }));
    const dialog = await screen.findByRole("dialog");
    const mic = await within(dialog).findByLabelText("Microfone");
    await within(dialog).findByRole("option", { name: "Microfone USB" });
    await user.selectOptions(mic, "mic1");
    expect(fake.setDevices).toContainEqual(["audioinput", "mic1"]);
    expect(JSON.parse(localStorage.getItem("spook:voice-devices") ?? "{}")).toEqual({
      audioinput: "mic1",
    });
    await user.selectOptions(within(dialog).getByLabelText("Câmera"), "cam1");
    await user.selectOptions(mic, "");
    expect(JSON.parse(localStorage.getItem("spook:voice-devices") ?? "{}")).toEqual({
      videoinput: "cam1",
    });
  });
});

describe("chamada em DM", () => {
  const DM = "dm1";
  function seedDm(s: Backend["state"]) {
    s.guilds.push(guild("g1", "Alfa", { permissions: FULL }));
    s.dms.push(dm(DM, [recipient(ME, "ana"), recipient("50", "bia")]));
  }

  it("botão Ligar no cabeçalho usa o ID da DM como sala; Sair da chamada encerra", async () => {
    const user = userEvent.setup();
    const app = await renderApp(`/channels/@me/${DM}`, { signedIn: true, seed: seedDm });
    await connectGateway(app.state.guilds, "s1", { private_channels: app.state.dms });
    await user.click(await screen.findByRole("button", { name: /Ligar/ }));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    expect(app.state.voice.tokensFor).toEqual([DM]);
    expect(within(bar).getByText("bia")).toBeInTheDocument(); // título da DM na barra
    // câmera e tela liberadas em DM
    expect(within(bar).getByRole("button", { name: "Ligar câmera" })).toBeEnabled();
    // o botão do cabeçalho da DM e o da barra fazem o mesmo
    await user.click(screen.getAllByRole("button", { name: "Sair da chamada" })[0] as HTMLElement);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Controles de voz" })).not.toBeInTheDocument(),
    );
  });

  it("chamada em andamento: indicação, participantes e Entrar na chamada", async () => {
    const user = userEvent.setup();
    const app = await renderApp(`/channels/@me/${DM}`, { signedIn: true, seed: seedDm });
    const sock = await connectGateway(app.state.guilds, "s1", { private_channels: app.state.dms });
    serverSends(sock, "VOICE_STATE_UPDATE", 2, voiceState("50", DM, { self_screen: true }));
    const panel = await screen.findByRole("region", { name: "Chamada em andamento" });
    expect(within(panel).getByText("1 pessoa")).toBeInTheDocument();
    expect(within(panel).getByRole("img", { name: "Compartilhando a tela" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Entrar na chamada" }));
    expect(await screen.findByRole("region", { name: "Controles de voz" })).toBeInTheDocument();
    expect(app.state.voice.tokensFor).toEqual([DM]);
  });
});

describe("volume por pessoa na lista de conectados", () => {
  async function enter(caps: FakeVoiceEngine["audioCapabilities"]) {
    fake.audioCapabilities = caps;
    const user = userEvent.setup();
    const { nav } = await open(FULL, [voiceState("50", VOICE, { self_screen: true })]);
    await user.click(voiceButton(nav));
    await within(await screen.findByRole("region", { name: "Controles de voz" })).findByText(
      "Voz conectada",
    );
    return { user, nav };
  }

  it("outra pessoa tem painel de volume (voz e tela); eu não; Esc fecha", async () => {
    const { user, nav } = await enter({
      strongNoiseSuppression: false,
      participantVolume: { max: 1 },
    });
    const list = await within(nav).findByRole("list", { name: "Conectados" });
    expect(within(list).getAllByRole("button", { name: /^Volume de / })).toHaveLength(1);
    await user.click(within(list).getByRole("button", { name: "Volume de bia" }));
    const panel = within(list).getByRole("group", { name: "Volume de bia" });
    const voice = within(panel).getByRole("slider", { name: /Volume da voz de bia/ });
    expect(voice).toHaveFocus();
    expect(within(panel).getByRole("slider", { name: /áudio da tela de bia/ })).toBeInTheDocument();
    fireEvent.change(voice, { target: { value: "40" } });
    expect(fake.volumes.at(-2)).toEqual(["50", "voice", 0.4]);
    expect(voice).toHaveAccessibleName(/40%/);
    await user.keyboard("{Escape}");
    expect(within(list).queryByRole("group", { name: "Volume de bia" })).toBeNull();
  });

  it("engine sem a capacidade (desktop por enquanto): nenhum controle de volume", async () => {
    const { nav } = await enter({ strongNoiseSuppression: false });
    const list = await within(nav).findByRole("list", { name: "Conectados" });
    expect(within(list).queryByRole("button", { name: /^Volume de / })).toBeNull();
  });
});
