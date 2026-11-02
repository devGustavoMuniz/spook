import { Permission } from "@spook/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useReadStateStore } from "@/features/notifications/read-state";
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

const MANAGE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_CHANNELS;
const channels = [
  channel("c1", "avisos", 0),
  channel("cat", "Texto", 1, 2),
  channel("a", "geral", 2, 0, "cat"),
  channel("b", "dev", 3, 0, "cat"),
  channel("cv", "Voz", 4, 2),
  channel("v", "sala", 5, 1, "cv"),
];
const seedAlfa = (s: { guilds: unknown[]; members: Record<string, unknown[]> }) => {
  s.guilds.push(guild("g1", "Alfa", { channels, permissions: MANAGE }));
  s.members.g1 = [member(ME, "ana")];
};

beforeEach(() => {
  useReadStateStore.getState().reset();
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as { matchMedia?: unknown }).matchMedia;
});

describe("categorias recolhíveis", () => {
  it("recolhe, esconde os canais quietos, persiste por servidor e reabre", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    const toggle = within(nav).getByRole("button", { name: "Texto" });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("link", { name: "dev" })).toBeInTheDocument();

    await user.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(within(nav).queryByRole("link", { name: "dev" })).toBeNull();
    // o canal aberto continua à vista
    expect(within(nav).getByRole("link", { name: "geral" })).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("spook:collapsed-categories:g1") ?? "[]")).toEqual([
      "cat",
    ]);

    await user.click(toggle);
    expect(within(nav).getByRole("link", { name: "dev" })).toBeInTheDocument();
  });

  it("lê o estado salvo e mantém visível o canal com não lidas", async () => {
    localStorage.setItem("spook:collapsed-categories:g1", JSON.stringify(["cat"]));
    useReadStateStore.getState().reset();
    await renderApp("/channels/g1/a", {
      signedIn: true,
      seed: seedAlfa,
    });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    expect(within(nav).getByRole("button", { name: "Texto" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    expect(within(nav).queryByRole("link", { name: "dev" })).toBeNull();
  });

  it("localStorage indisponível não quebra a lista", async () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const setSpy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("bloqueado");
    });
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    await user.click(within(nav).getByRole("button", { name: "Texto" }));
    expect(within(nav).queryByRole("link", { name: "dev" })).toBeNull();
    spy.mockRestore();
    setSpy.mockRestore();
  });

  it("o botão + por categoria tem dica e só aparece com permissão", async () => {
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    expect(within(nav).getByRole("button", { name: "Criar canal em Texto" })).toBeInTheDocument();
  });
});

describe("barra de servidores", () => {
  it("marca o servidor ativo com aria-current e mostra o nome em dica", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", {
      signedIn: true,
      seed: (s) => {
        seedAlfa(s);
        s.guilds.push(guild("g2", "Beta"));
        s.members.g2 = [member(ME, "ana")];
      },
    });
    const rail = await screen.findByRole("navigation", { name: "Servidores" });
    expect(within(rail).getByRole("link", { name: "Alfa" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(rail).getByRole("link", { name: "Beta" })).not.toHaveAttribute("aria-current");
    await user.hover(within(rail).getByRole("link", { name: "Beta" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Beta");
  });

  it("menções entram no nome acessível e o contador vira 99+", async () => {
    useReadStateStore.getState().reset();
    await renderApp("/channels/g1/a", {
      signedIn: true,
      seed: seedAlfa,
    });
    await screen.findByRole("navigation", { name: "Servidores" });
    act(() =>
      useReadStateStore.getState().replaceAll([
        {
          channel_id: "b",
          guild_id: "g1",
          unread_count: 120,
          mention_count: 150,
          last_read_message_id: "1",
        },
      ] as never),
    );
    const rail = screen.getByRole("navigation", { name: "Servidores" });
    await waitFor(() =>
      expect(within(rail).getByRole("link", { name: "Alfa, 99+ menções" })).toBeInTheDocument(),
    );
    expect(within(rail).getByRole("img", { name: "99+ menções em Alfa" })).toBeInTheDocument();
  });
});

describe("shell responsivo", () => {
  it("em 390 px a navegação vira drawer: abre pelo botão, fecha com Esc e devolve o foco", async () => {
    setViewport(390);
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    const open = await screen.findByRole("button", { name: "Abrir menu de navegação" });
    const drawer = screen.getByRole("dialog", { name: "Navegação", hidden: true });
    expect(drawer).toHaveAttribute("data-state", "closed");
    expect(drawer).toHaveAttribute("inert");

    await user.click(open);
    expect(drawer).toHaveAttribute("data-state", "open");
    expect(drawer).toHaveAttribute("aria-modal", "true");
    expect(drawer).not.toHaveAttribute("inert");
    // servidores e canais dentro do drawer
    expect(within(drawer).getByRole("navigation", { name: "Servidores" })).toBeInTheDocument();
    expect(within(drawer).getByRole("navigation", { name: "Canais" })).toBeInTheDocument();
    await waitFor(() => expect(drawer.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Escape}");
    expect(drawer).toHaveAttribute("data-state", "closed");
    await waitFor(() => expect(document.activeElement).toBe(open));
  });

  it("o foco fica preso no drawer (Tab dá a volta) e o toque fora fecha", async () => {
    setViewport(390);
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await user.click(await screen.findByRole("button", { name: "Abrir menu de navegação" }));
    const drawer = screen.getByRole("dialog", { name: "Navegação" });
    for (let i = 0; i < 80; i++) {
      await user.tab();
      expect(drawer.contains(document.activeElement)).toBe(true);
    }
    await user.click(drawer.previousElementSibling as HTMLElement);
    expect(drawer).toHaveAttribute("data-state", "closed");
  });

  it("navegar para um canal fecha o drawer", async () => {
    setViewport(390);
    const user = userEvent.setup();
    const { router } = await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await user.click(await screen.findByRole("button", { name: "Abrir menu de navegação" }));
    const drawer = screen.getByRole("dialog", { name: "Navegação" });
    await user.click(within(drawer).getByRole("link", { name: "dev" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/channels/g1/b"));
    expect(drawer).toHaveAttribute("data-state", "closed");
  });

  it("em desktop não há drawer nem botão de menu visível no fluxo", async () => {
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await screen.findByRole("navigation", { name: "Canais" });
    expect(screen.queryByRole("dialog", { name: "Navegação", hidden: true })).toBeNull();
  });

  it("membros viram sheet pela direita abaixo de 1024 px", async () => {
    setViewport(900);
    const user = userEvent.setup();
    await renderApp("/channels/g1/a", { signedIn: true, seed: seedAlfa });
    await user.click(await screen.findByRole("button", { name: "Mostrar membros" }));
    const sheet = screen.getByRole("dialog", { name: "Membros" });
    expect(sheet).toHaveAttribute("data-state", "open");
    await user.keyboard("{Escape}");
    expect(sheet).toHaveAttribute("data-state", "closed");
  });
});
