import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channel, guild, ME, member } from "@/test/fixtures";
import { renderApp } from "@/test/render";

/** jsdom não tem matchMedia: simula uma largura (`max-width: N` casa quando a largura é <= N). */
function setViewport(width: number) {
  vi.stubGlobal("matchMedia", (query: string) => {
    const max = /max-width:\s*(\d+)px/.exec(query);
    return {
      matches: max ? width <= Number(max[1]) : false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
  });
  window.matchMedia = globalThis.matchMedia;
}

const seedAlfa = (s: { guilds: unknown[]; members: Record<string, unknown[]> }) => {
  s.guilds.push(guild("g1", "Alfa", { channels: [channel("a", "geral", 0)] }));
  s.members.g1 = [member(ME, "ana")];
};

const settingsNav = () => screen.findByRole("navigation", { name: "Seções das configurações" });

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { matchMedia?: unknown }).matchMedia;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("configurações em tela cheia", () => {
  it("/settings abre o perfil no desktop, com navegação lateral e um único h1", async () => {
    const { router } = await renderApp("/settings", { signedIn: true });
    const nav = await settingsNav();
    expect(await screen.findByRole("heading", { level: 1, name: "Perfil" })).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/settings/profile");
    for (const name of ["Perfil", "Notificações", "Voz e vídeo", "Aparência e idioma"])
      expect(within(nav).getByRole("link", { name })).toBeInTheDocument();
    expect(within(nav).getByRole("link", { name: "Perfil" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByRole("main")).toBeInTheDocument();
    // tela cheia: sem a barra de servidores
    expect(screen.queryByRole("navigation", { name: "Servidores" })).toBeNull();
  });

  it("deep link por seção e troca pela navegação", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/voice", { signedIn: true });
    expect(await screen.findByRole("heading", { level: 1, name: "Voz e vídeo" })).toHaveFocus();
    expect(screen.getByLabelText("Microfone")).toBeInTheDocument();
    await user.click(within(await settingsNav()).getByRole("link", { name: "Aparência e idioma" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Aparência e idioma" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("/profile (endereço antigo) vai para /settings/profile", async () => {
    const { router } = await renderApp("/profile", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    expect(router.state.location.pathname).toBe("/settings/profile");
  });

  it("fechar volta para a tela em que a pessoa estava; Esc também", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await user.click(await screen.findByRole("link", { name: "Configurações do usuário" }));
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    expect(router.state.location.pathname).toBe("/settings/profile");
    await user.click(screen.getByRole("button", { name: "Fechar configurações" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/channels/g1/a"));

    await user.click(await screen.findByRole("link", { name: "Configurações do usuário" }));
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(router.state.location.pathname).toBe("/channels/g1/a"));
  });

  it("aberta direto por link, fechar leva ao início", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings/notifications", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: "Notificações" });
    await user.click(screen.getByRole("button", { name: "Fechar configurações" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("Esc não fecha quando há um diálogo aberto", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings/profile", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.appendChild(dialog);
    await user.keyboard("{Escape}");
    expect(router.state.location.pathname).toBe("/settings/profile");
    dialog.remove();
  });

  it("Aplicativo só aparece no desktop", async () => {
    await renderApp("/settings/profile", { signedIn: true });
    const nav = await settingsNav();
    expect(within(nav).queryByRole("link", { name: "Aplicativo" })).toBeNull();
  });

  it("Aparência: escolher o tema aplica e persiste", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/appearance", { signedIn: true });
    const dark = await screen.findByRole("radio", { name: /Escuro/ });
    expect(screen.getByRole("radio", { name: /Sistema/ })).toBeChecked();
    await user.click(dark);
    expect(dark).toBeChecked();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("spook-theme")).toBe("dark");
    await user.click(screen.getByRole("radio", { name: /Claro/ }));
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(screen.getByText(/Movimento reduzido/)).toBeInTheDocument();
  });

  it("Aparência e idioma: trocar o idioma traduz a tela na hora e persiste", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/appearance", { signedIn: true });
    const select = await screen.findByLabelText("Idioma");
    expect(select).toHaveValue("pt-BR");
    await user.selectOptions(select, "en");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Appearance & language" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Language")).toHaveValue("en");
    expect(localStorage.getItem("spook-locale")).toBe("en");
    expect(document.documentElement.lang).toBe("en");
  });

  it("Perfil mostra usuário e e-mail só para leitura e o menu do usuário leva às configurações", async () => {
    await renderApp("/settings/profile", { signedIn: true });
    expect(await screen.findByText("ana@spook.dev")).toBeInTheDocument();
    expect(screen.getByText("Nome de exibição", { selector: "h2" })).toBeInTheDocument();
  });
});

describe("configurações no celular (390 px)", () => {
  beforeEach(() => setViewport(390));

  it("/settings mostra a lista; escolher abre o detalhe com voltar", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Configurações" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
    await user.click(within(await settingsNav()).getByRole("link", { name: "Notificações" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Notificações" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Seções das configurações" })).toBeNull();
    await user.click(screen.getByRole("link", { name: "Voltar às configurações" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Configurações" }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings");
  });

  it("deep link abre direto o detalhe", async () => {
    await renderApp("/settings/appearance", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Aparência e idioma" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar às configurações" })).toBeInTheDocument();
  });
});
