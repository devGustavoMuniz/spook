import type { VoiceStatePayload } from "@spook/shared";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "@/lib/query";
import { ME } from "@/test/fixtures";
import { type Backend, makeBackend, server } from "@/test/server";
import { saveViewStreamPreviews } from "./devices";
import type { WatchAction } from "./stream-card";
import { VoiceParticipants } from "./voice-participants";

const names: Record<string, string> = { [ME]: "Ana", "7": "Bia", "8": "Caio" };
const lookup = (id: string) => ({ name: names[id] ?? "Usuário" });
const st = (user_id: string, extra: Partial<VoiceStatePayload> = {}): VoiceStatePayload => ({
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

let backend: Backend;
let watch: WatchAction;

function mount(participants: VoiceStatePayload[], w: Partial<WatchAction> = {}) {
  watch = { onWatch: vi.fn(), canConnect: true, ...w };
  backend = makeBackend({ signedIn: true });
  server.use(...backend.handlers);
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { retry: false } });
  return render(
    <QueryClientProvider client={client}>
      <VoiceParticipants participants={participants} lookup={lookup} watch={watch} />
    </QueryClientProvider>,
  );
}

const ready = () => screen.findByRole("button", { name: "Ver a transmissão de Bia" });
const trigger = (name = "Bia") =>
  screen.getByRole("button", { name: `Ver a transmissão de ${name}` });
const card = (name = "Bia") => screen.queryByRole("dialog", { name: `Transmissão de ${name}` });

beforeEach(() => {
  localStorage.clear();
  let n = 0;
  URL.createObjectURL = vi.fn(() => `blob:thumb-${++n}`);
  URL.revokeObjectURL = vi.fn();
});

describe("cartão da transmissão: abrir e fechar", () => {
  it("só quem transmite (e não sou eu) tem o cartão; o ícone de tela segue com o texto para leitores de tela", async () => {
    mount([st(ME, { self_screen: true }), st("7", { self_screen: true }), st("8")]);
    await ready();
    expect(screen.getAllByRole("img", { name: "Compartilhando a tela" })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /Ver a transmissão de (Ana|Caio)/ })).toBeNull();
  });

  it("passar o mouse no nome abre com atraso (~250 ms) e sair fecha", async () => {
    mount([st(ME), st("7", { self_screen: true })]);
    const row = (await ready()).parentElement as HTMLElement;
    fireEvent.mouseEnter(row);
    expect(card()).toBeNull(); // ainda no atraso
    expect(await screen.findByRole("dialog", { name: "Transmissão de Bia" })).toBeInTheDocument();
    fireEvent.mouseLeave(row);
    await waitFor(() => expect(card()).toBeNull());
  });

  it("o mouse pode ir do ícone para o cartão sem ele fechar", async () => {
    mount([st(ME), st("7", { self_screen: true })]);
    const row = (await ready()).parentElement as HTMLElement;
    fireEvent.mouseEnter(row);
    const dlg = await screen.findByRole("dialog", { name: "Transmissão de Bia" });
    fireEvent.mouseLeave(row);
    fireEvent.mouseEnter(dlg);
    await new Promise((r) => setTimeout(r, 300));
    expect(card()).not.toBeNull();
    fireEvent.mouseLeave(dlg);
    await waitFor(() => expect(card()).toBeNull());
  });

  it("foco por teclado abre na hora; Esc fecha e devolve o foco ao ícone", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })]);
    await ready();
    await user.tab();
    expect(trigger()).toHaveFocus();
    expect(card()).not.toBeNull();
    await user.keyboard("{Escape}");
    expect(card()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("Tab no ícone com o cartão aberto leva ao botão (o cartão fica fora da ordem do DOM)", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })]);
    await ready();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: /Assistir transmissão/ })).toHaveFocus();
    await user.tab(); // sair do cartão devolve ao ícone e fecha
    expect(card()).toBeNull();
    expect(trigger()).toHaveFocus();
  });

  it("toque/clique no ícone abre (celular, sem hover) e outro clique fecha", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })]);
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    expect(card()).not.toBeNull();
    expect(trigger()).toHaveAttribute("aria-expanded", "true");
    await new Promise((r) => setTimeout(r, 450)); // passou o instante do foco: agora o clique alterna
    await user.click(trigger());
    expect(card()).toBeNull();
  });
});

describe("cartão da transmissão: conteúdo", () => {
  it("mostra 'Tela de Bia', 'Ao vivo' e, sem prévia, só o ícone e o botão (sem requisição)", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })]);
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    const dlg = screen.getByRole("dialog", { name: "Transmissão de Bia" });
    expect(dlg).toHaveTextContent("Tela de Bia");
    expect(dlg).toHaveTextContent("Ao vivo");
    expect(dlg.querySelector("img")).toBeNull();
    expect(screen.getByRole("button", { name: "Assistir transmissão de Bia" })).toBeEnabled();
    expect(backend.state.voice.previewGets).toEqual([]);
  });

  it("com prévia: skeleton enquanto carrega e depois a miniatura com alt acessível", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true, screen_preview: true })]);
    backend.state.voice.previews["c1/7"] = [0xff, 0xd8, 0xff, 0xd9];
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    expect(await screen.findByRole("img", { name: "Prévia da tela de Bia" })).toHaveAttribute(
      "src",
      "blob:thumb-1",
    );
    expect(backend.state.voice.previewGets).toEqual(["c1/7"]);
  });

  it("prévia que sumiu (404) cai no ícone, sem quebrar", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true, screen_preview: true })]);
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    await waitFor(() => expect(backend.state.voice.previewGets).toEqual(["c1/7"]));
    expect(screen.queryByRole("img", { name: /Prévia da tela/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Assistir transmissão/ })).toBeEnabled();
  });

  it("a opção local 'Mostrar prévias das transmissões' desligada: nem busca a miniatura", async () => {
    saveViewStreamPreviews(false);
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true, screen_preview: true })]);
    backend.state.voice.previews["c1/7"] = [0xff, 0xd8, 0xff, 0xd9];
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    expect(screen.getByRole("dialog", { name: "Transmissão de Bia" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(backend.state.voice.previewGets).toEqual([]);
    expect(screen.queryByRole("img", { name: /Prévia da tela/ })).toBeNull();
  });
});

describe("cartão da transmissão: assistir", () => {
  it("o botão pede para assistir a tela daquela pessoa e fecha o cartão", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })]);
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    await user.click(screen.getByRole("button", { name: /Assistir transmissão/ }));
    expect(watch.onWatch).toHaveBeenCalledWith("7");
    expect(card()).toBeNull();
  });

  it("funciona só com o teclado: Tab até o botão e Enter", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })]);
    await ready();
    await user.tab();
    await user.tab();
    await user.keyboard("{Enter}");
    expect(watch.onWatch).toHaveBeenCalledWith("7");
  });

  it("sem permissão para conectar: botão desabilitado, com o motivo", async () => {
    const user = userEvent.setup();
    mount([st(ME), st("7", { self_screen: true })], { canConnect: false });
    await user.click(await screen.findByRole("button", { name: "Ver a transmissão de Bia" }));
    const btn = screen.getByRole("button", { name: /Assistir transmissão/ });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(
      "Você não tem permissão para entrar neste canal de voz.",
    );
    await user.click(btn);
    expect(watch.onWatch).not.toHaveBeenCalled();
  });
});
