import { Permission } from "@spook/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetVoiceController } from "@/features/voice/controller";
import { setVoiceEngineFactory } from "@/features/voice/engine-provider";
import { useVoiceStore } from "@/features/voice/store";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
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

/** O endereço que a pessoa vê (a máscara `/settings/<seção>`); a rota de verdade continua sendo a do app atrás. */
const shownPath = (router: { history: { location: { pathname: string } } }) =>
  router.history.location.pathname;

const dialog = () => screen.findByRole("dialog", { name: "Configurações" });

describe("configurações em modal", () => {
  it("/settings abre o app com o modal no perfil: menu agrupado, um único h1 e o app atrás", async () => {
    const { router } = await renderApp("/settings", { signedIn: true });
    const modal = await dialog();
    expect(modal).toHaveAttribute("aria-modal", "true");
    expect(
      await within(modal).findByRole("heading", { level: 1, name: "Perfil" }),
    ).toBeInTheDocument();
    expect(within(modal).getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(shownPath(router)).toBe("/settings/profile");
    // o app continua montado atrás (o modal é só um parâmetro da rota)
    expect(router.state.location.pathname).toBe("/");
    expect(document.querySelector('nav[aria-label="Servidores"]')).not.toBeNull();

    const nav = await settingsNav();
    expect(within(nav).getByRole("heading", { level: 2, name: "Conta" })).toBeInTheDocument();
    expect(within(nav).getByRole("heading", { level: 2, name: "App" })).toBeInTheDocument();
    const names = within(nav)
      .getAllByRole("link")
      .map((a) => a.textContent);
    expect(names.slice(0, 5)).toEqual([
      "Perfil",
      "Bloqueados",
      "Notificações",
      "Voz e vídeo",
      "Aparência e idioma",
    ]);
    expect(within(nav).getByRole("link", { name: "Perfil" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(modal).getByRole("main")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: "Sair" })).toBeInTheDocument();
  });

  it("deep link por seção e troca pelo menu", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings/voice", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Voz e vídeo" }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Microfone")).toBeInTheDocument();
    await user.click(within(await settingsNav()).getByRole("link", { name: "Aparência e idioma" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Aparência e idioma" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(shownPath(router)).toBe("/settings/appearance");
  });

  it("setas movem o foco no menu; só o item atual entra no Tab", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/profile", { signedIn: true });
    const nav = await settingsNav();
    const links = within(nav).getAllByRole("link");
    expect(links[0]).toHaveAttribute("tabindex", "0");
    expect(links[1]).toHaveAttribute("tabindex", "-1");
    links[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(within(nav).getByRole("link", { name: "Bloqueados" })).toHaveFocus();
    await user.keyboard("{ArrowDown}{ArrowUp}{End}");
    expect(within(nav).getByRole("button", { name: "Sair" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(within(nav).getByRole("link", { name: "Perfil" })).toHaveFocus();
  });

  it("/profile (endereço antigo) abre o modal no perfil", async () => {
    const { router } = await renderApp("/profile", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    expect(shownPath(router)).toBe("/settings/profile");
  });

  it("seção desconhecida cai na lista/perfil em vez de quebrar", async () => {
    await renderApp("/settings/inexistente", { signedIn: true });
    expect(await screen.findByRole("heading", { level: 1, name: "Perfil" })).toBeInTheDocument();
  });

  it("fechar (botão ou Esc) volta à rota anterior, sem remontar o app", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    const railBefore = await screen.findByRole("navigation", { name: "Servidores" });
    await user.click(await screen.findByRole("button", { name: "Configurações do usuário" }));
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    expect(shownPath(router)).toBe("/settings/profile");
    expect(router.state.location.pathname).toBe("/channels/g1/a");
    await user.click(screen.getByRole("button", { name: "Fechar configurações" }));
    await waitFor(() => expect(shownPath(router)).toBe("/channels/g1/a"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // o mesmo nó: o app atrás não foi desmontado
    expect(await screen.findByRole("navigation", { name: "Servidores" })).toBe(railBefore);

    await user.click(await screen.findByRole("button", { name: "Configurações do usuário" }));
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(shownPath(router)).toBe("/channels/g1/a"));
    expect(await screen.findByRole("navigation", { name: "Servidores" })).toBe(railBefore);
  });

  it("o botão de engrenagem reabre a última seção vista", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await user.click(await screen.findByRole("button", { name: "Configurações do usuário" }));
    await user.click(within(await settingsNav()).getByRole("link", { name: "Notificações" }));
    await screen.findByRole("heading", { level: 1, name: "Notificações" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await user.click(await screen.findByRole("button", { name: "Configurações do usuário" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Notificações" }),
    ).toBeInTheDocument();
  });

  it("Voltar do navegador fecha o modal", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await user.click(await screen.findByRole("button", { name: "Configurações do usuário" }));
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    act(() => router.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(shownPath(router)).toBe("/channels/g1/a");
  });

  it("aberta direto por link, fechar deixa o usuário no app (início)", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings/notifications", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: "Notificações" });
    await user.click(screen.getByRole("button", { name: "Fechar configurações" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(shownPath(router)).toBe("/");
  });

  it("Esc fecha só o diálogo de cima (não as configurações inteiras)", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/profile", { signedIn: true });
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    await user.click(screen.getByRole("button", { name: "Excluir minha conta" }));
    const inner = await screen.findByRole("dialog", { name: /Excluir/ });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(inner).not.toBeInTheDocument());
    expect(screen.getByRole("dialog", { name: "Configurações" })).toBeInTheDocument();
  });

  it("o foco fica preso no modal e volta ao botão que o abriu", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    const gear = await screen.findByRole("button", { name: "Configurações do usuário" });
    gear.focus();
    await user.click(gear);
    const modal = await dialog();
    await waitFor(() => expect(modal).toContainElement(document.activeElement as HTMLElement));
    // o foco inicial é o item atual do menu
    expect(within(modal).getByRole("link", { name: "Perfil" })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(modal).toContainElement(document.activeElement as HTMLElement);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Configurações do usuário" })).toHaveFocus(),
    );
  });

  it("abrir e fechar as configurações não derruba a chamada de voz", async () => {
    const fake = new FakeVoiceEngine();
    setVoiceEngineFactory(() => fake);
    resetVoiceController();
    const user = userEvent.setup();
    await renderApp("/channels/g1/g1-txt", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(
          guild("g1", "Alfa", {
            permissions:
              Permission.VIEW_CHANNEL |
              Permission.SEND_MESSAGES |
              Permission.CONNECT |
              Permission.SPEAK,
          }),
        );
        s.members.g1 = [member(ME, "ana")];
      },
    });
    const canais = await screen.findByRole("navigation", { name: "Canais" });
    await user.click(within(canais).getByRole("button", { name: /Geral \(canal de voz/ }));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    await user.click(within(bar).getByRole("link", { name: "Meu perfil" }));
    await screen.findByRole("heading", { level: 1, name: "Perfil" });
    // a chamada continua, e o cartão de voz está montado atrás do modal
    expect(fake.state).toBe("connected");
    expect(useVoiceStore.getState().status).not.toBe("idle");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configurações" })).toBeNull());
    expect(await screen.findByText("Voz conectada")).toBeInTheDocument();
    expect(fake.calls.filter((c) => c === "disconnect")).toHaveLength(0);
  });

  it("Aplicativo só aparece no desktop (último do grupo App)", async () => {
    await renderApp("/settings/profile", { signedIn: true });
    const nav = await settingsNav();
    expect(within(nav).queryByRole("link", { name: "Aplicativo" })).toBeNull();
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await renderApp("/settings/profile", { signedIn: true });
    const navs = await screen.findAllByRole("navigation", { name: "Seções das configurações" });
    const links = within(navs[navs.length - 1] as HTMLElement).getAllByRole("link");
    expect(links.at(-1)).toHaveTextContent("Aplicativo");
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

  it("o modal vira folha em tela cheia: lista, detalhe com voltar e fechar", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/settings", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Configurações" }),
    ).toBeInTheDocument();
    expect(shownPath(router)).toBe("/settings");
    expect((await dialog()).className).toContain("h-dvh");
    await user.click(within(await settingsNav()).getByRole("link", { name: "Notificações" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Notificações" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Seções das configurações" })).toBeNull();
    expect(shownPath(router)).toBe("/settings/notifications");
    await user.click(screen.getByRole("button", { name: "Voltar às configurações" }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Configurações" }),
    ).toBeInTheDocument();
    expect(shownPath(router)).toBe("/settings");
    await user.click(screen.getByRole("button", { name: "Fechar configurações" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Configurações" })).toBeNull());
  });

  it("deep link abre direto o detalhe", async () => {
    await renderApp("/settings/appearance", { signedIn: true });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Aparência e idioma" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voltar às configurações" })).toBeInTheDocument();
  });
});
