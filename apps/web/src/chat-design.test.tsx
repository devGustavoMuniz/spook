import { Permission } from "@spook/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { guild, ME, member, messages, role } from "@/test/fixtures";
import { connectGateway } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.MANAGE_MESSAGES |
  Permission.KICK_MEMBERS;

const log = () => screen.findByRole("log", { name: "Mensagens de geral" });
const articleOf = async (text: string) =>
  (await within(await log()).findByText(text)).closest("article") as HTMLElement;

function seed(extra: (s: Backend["state"]) => void = () => {}) {
  return (s: Backend["state"]) => {
    s.guilds.push(
      guild("g1", "Alfa", {
        permissions: BASE,
        my_role_ids: ["mod"],
        roles: [
          role("g1", "@everyone", 0, { is_everyone: true }),
          role("mod", "Moderadores", 5, { color: 0x3366ff, permissions: BASE }),
        ],
      }),
    );
    s.members.g1 = [
      member(ME, "ana", ["mod"]),
      member("50", "bia", ["mod"]),
      member("60", "caio"),
      member("70", "dora"),
    ];
    s.messages[CH] = messages(CH, 3, 1000);
    extra(s);
  };
}

describe("chat: grupos e cabeçalho", () => {
  it("mensagens seguidas do mesmo autor têm um só cabeçalho (nome e hora com tooltip de data completa)", async () => {
    await renderApp(path, { signedIn: true, seed: seed() });
    const list = await log();
    await within(list).findByText("mensagem 1002");
    expect(within(list).getAllByRole("button", { name: "Ver perfil de bia" })).toHaveLength(2);
    // um cabeçalho: o nome aparece uma vez; o avatar e o nome são os dois botões acima
    expect(within(list).getAllByText("bia")).toHaveLength(1);
    expect(list.querySelectorAll("article[data-header]")).toHaveLength(1);
  });

  it("separador de dia legível entre mensagens de dias diferentes", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        const list = messages(CH, 2, 1000);
        const [a, b] = list;
        if (a && b)
          b.created_at = new Date(Date.parse(a.created_at) + 26 * 3_600_000).toISOString();
        s.messages[CH] = list;
      }),
    });
    const list = await log();
    await within(list).findByText("mensagem 1001");
    expect(within(list).getAllByRole("separator")).toHaveLength(2);
    expect(within(list).getByText(/30 de outubro de 2026/)).toBeVisible();
    expect(within(list).getByRole("separator", { name: /30 de outubro de 2026/ })).toBeVisible();
    expect(within(list).getByRole("separator", { name: /31 de outubro de 2026/ })).toBeVisible();
  });

  it("menção a quem está na conversa vira pílula; a minha ganha o realce forte", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        const m = messages(CH, 1, 1000)[0];
        if (m) {
          m.content = "oi @ana e @bia, @ninguem e a@bia.com";
          s.messages[CH] = [m];
        }
      }),
    });
    const article = await articleOf("oi @ana e @bia, @ninguem e a@bia.com").catch(
      async () => (await within(await log()).findByText(/oi/)).closest("article") as HTMLElement,
    );
    const pills = article.querySelectorAll("mark");
    expect([...pills].map((p) => p.textContent)).toEqual(["@ana", "@bia"]);
    expect(pills[0]).toHaveAttribute("data-mention-pill", "me");
    expect(pills[1]).toHaveAttribute("data-mention-pill", "other");
  });
});

describe("chat: ações da mensagem", () => {
  it("barra de ações no foco, por teclado: responder, fixar, editar/excluir conforme a permissão e 'Mais'", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const article = await articleOf("mensagem 1000");
    const bar = within(article).getByRole("toolbar", { name: "Ações da mensagem" });
    expect(within(bar).getByRole("button", { name: "Responder" })).toBeInTheDocument();
    expect(within(bar).getByRole("button", { name: "Fixar mensagem" })).toBeInTheDocument();
    // outra pessoa escreveu: sem editar; com MANAGE_MESSAGES pode excluir
    expect(within(bar).queryByRole("button", { name: "Editar mensagem" })).toBeNull();
    expect(within(bar).getByRole("button", { name: "Excluir mensagem" })).toBeInTheDocument();
    // alcançável por Tab a partir da mensagem
    article.focus();
    const reply = within(bar).getByRole("button", { name: "Responder" });
    for (let i = 0; i < 6 && document.activeElement !== reply; i++) await user.tab();
    expect(reply).toHaveFocus();
  });

  it("'Mais ações' copia o texto e o ID da mensagem", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await renderApp(path, { signedIn: true, seed: seed() });
    const article = await articleOf("mensagem 1001");
    await user.click(within(article).getByRole("button", { name: "Mais ações" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copiar texto" }));
    expect(writeText).toHaveBeenCalledWith("mensagem 1001");
    await user.click(within(article).getByRole("button", { name: "Mais ações" }));
    await user.click(await screen.findByRole("menuitem", { name: "Copiar ID da mensagem" }));
    expect(writeText).toHaveBeenLastCalledWith("1001");
  });

  it("em toque: botão '⋯' abre o menu completo e o toque longo também", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const article = await articleOf("mensagem 1000");
    await user.click(within(article).getByRole("button", { name: "Ações da mensagem de bia" }));
    expect(await screen.findByRole("menuitem", { name: "Responder" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Excluir" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Responder" })).toBeNull());

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const ev = new Event("pointerdown", { bubbles: true });
      Object.defineProperty(ev, "pointerType", { value: "touch" });
      article.dispatchEvent(ev);
      await vi.advanceTimersByTimeAsync(500);
    } finally {
      vi.useRealTimers();
    }
    expect(await screen.findByRole("menuitem", { name: "Responder" })).toBeInTheDocument();
  });
});

describe("chat: visualizador de imagens", () => {
  const img = (id: string) => ({
    id,
    filename: `${id}.png`,
    content_type: "image/png",
    size: 2048,
    url: `https://s.test/orig/${id}`,
    width: 800,
    height: 600,
  });

  it("as setas passam pelas imagens da conversa inteira; zoom por clique; Esc devolve o foco", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        const list = messages(CH, 2, 1000);
        if (list[0]) list[0].attachments = [img("a")];
        if (list[1]) list[1].attachments = [img("b")];
        s.messages[CH] = list;
      }),
    });
    const list = await log();
    await user.click(await within(list).findByRole("button", { name: "Abrir imagem a.png" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("1 / 2")).toBeInTheDocument();
    await user.keyboard("{ArrowRight}");
    expect(within(dialog).getByRole("img", { name: "b.png" })).toBeInTheDocument();
    expect(within(dialog).getByText("2 / 2")).toBeInTheDocument();

    const zoomBtn = within(dialog).getByRole("button", { name: "Ampliar imagem" });
    await user.click(zoomBtn);
    expect(within(dialog).getByRole("button", { name: "Reduzir imagem" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    fireEvent.click(within(dialog).getByRole("img", { name: "b.png" }));
    expect(within(dialog).getByRole("button", { name: "Ampliar imagem" })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // o foco volta à miniatura que abriu o visualizador (a.png)
    expect(screen.getByRole("button", { name: "Abrir imagem a.png" })).toHaveFocus();
  });
});

describe("chat: estados vazios e carregamento", () => {
  it("canal sem mensagens mostra a ilustração e leva o foco ao campo", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        s.messages[CH] = [];
      }),
    });
    expect(await screen.findByText(/Ainda não há mensagens em #geral/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Escrever a primeira mensagem/ }));
    expect(screen.getByLabelText("Mensagem em #geral")).toHaveFocus();
  });
});

describe("lista de membros", () => {
  it("agrupa por cargo (online), Online e Offline, com contagem; o menu mantém as ações", async () => {
    const user = userEvent.setup();
    const app = await renderApp(path, { signedIn: true, seed: seed() });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("dora");
    await connectGateway(app.state.guilds, "s", {
      presences: [
        { user_id: "50", status: "online" },
        { user_id: "70", status: "idle", custom_status: { text: "em foco", emoji: "🎧" } },
      ],
    });
    const headers = await waitFor(() => {
      const h = within(panel).getAllByRole("heading", { level: 3 });
      expect(h).toHaveLength(3);
      return h.map((x) => x.textContent);
    });
    expect(headers[0]).toMatch(/Moderadores\s*— 2/);
    expect(headers[1]).toMatch(/Online\s*— 1/);
    expect(headers[2]).toMatch(/Offline\s*— 1/);
    expect(within(panel).getByText(/em foco/)).toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    expect(await screen.findByRole("menuitem", { name: "Enviar mensagem" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Copiar ID de usuário" })).toBeInTheDocument();
  });

  it("cartão de perfil: nome, @username, cargos, membro desde e ações; Esc fecha", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(await within(panel).findByRole("button", { name: "Ver perfil de bia" }));
    const card = await screen.findByRole("dialog", { name: "Perfil de bia" });
    expect(within(card).getByText("@bia")).toBeInTheDocument();
    expect(within(card).getByRole("list", { name: "Cargos" })).toHaveTextContent("Moderadores");
    expect(within(card).getByText(/30 de outubro de 2026/)).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Enviar mensagem/ })).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Copiar ID de usuário/ })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Perfil de bia" })).toBeNull());
  });

  it("clicar no nome do autor na mensagem abre o cartão dele", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const list = await log();
    const [first] = await within(list).findAllByRole("button", { name: "Ver perfil de bia" });
    if (first) await user.click(first);
    expect(await screen.findByRole("dialog", { name: "Perfil de bia" })).toBeInTheDocument();
  });
});

describe("avatar", () => {
  it("sem imagem mostra iniciais (não a mini logo) e fora do texto da página", async () => {
    await renderApp(path, { signedIn: true, seed: seed() });
    const list = await log();
    const avatar = (await within(list).findAllByRole("img", { name: "Avatar de bia" }))[0];
    expect(avatar?.tagName).toBe("SPAN");
    expect(avatar).toHaveAttribute("data-initials", "BI");
    expect(avatar).toHaveTextContent("");
  });
});
