import { ApiError, Permission } from "@spook/shared";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "@/components/error-boundary";
import { ErrorState } from "@/components/state-screen";
import { dm, guild, ME, member, recipient, role } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { type Backend, server } from "@/test/server";

const roles = [
  role("adm", "Admin", 5, { color: 0xff0000 }),
  role("mod", "Moderador", 3),
  role("vip", "VIP", 1, { color: 0x00ff00 }),
  role("g1", "@everyone", 0, { is_everyone: true }),
];
const seedRoles = (s: Backend["state"]) => {
  s.guilds.push(
    guild("g1", "Alfa", {
      roles,
      my_role_ids: ["adm"],
      is_owner: true,
      permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_ROLES | Permission.MANAGE_GUILD,
    }),
  );
  s.members.g1 = [member(ME, "ana", ["adm"])];
};

async function openRoles(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
  await user.click(await screen.findByRole("menuitem", { name: "Cargos" }));
  return screen.findByRole("list", { name: "Cargos" });
}

describe("diálogo de cargos", () => {
  it("lista → detalhe, com permissões agrupadas e botão de voltar para o celular", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", { signedIn: true, seed: seedRoles });
    const list = await openRoles(user);
    const dialog = screen.getByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Cargos e permissões" }),
    ).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: /VIP/ }));
    // o detalhe tem o botão de voltar (visível só < 768 px) e as permissões em grupos
    const back = within(dialog).getByRole("button", { name: "Todos os cargos" });
    for (const g of ["Geral", "Texto", "Voz", "Moderação"])
      expect(within(dialog).getByRole("heading", { name: g, level: 3 })).toBeInTheDocument();
    expect(within(dialog).getByRole("switch", { name: "Conectar à voz" })).toBeInTheDocument();
    await user.click(back);
    expect(within(dialog).getByRole("list", { name: "Cargos" })).toBeInTheDocument();
  });

  it("amostras de cor com rótulo; mudar habilita salvar e Esc pergunta antes de descartar", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", { signedIn: true, seed: seedRoles });
    const list = await openRoles(user);
    await user.click(within(list).getByRole("button", { name: /VIP/ }));
    const save = screen.getByRole("button", { name: "Salvar cargo" });
    expect(save).toBeDisabled();
    const blue = screen.getByRole("button", { name: "Cor Azul" });
    expect(blue).toHaveAttribute("aria-pressed", "false");
    await user.click(blue);
    expect(blue).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Azul")).toBeInTheDocument();
    expect(screen.getByText("Alterações não salvas")).toBeVisible();
    expect(save).toBeEnabled();

    await user.keyboard("{Escape}");
    const confirm = await screen.findByRole("alertdialog");
    expect(within(confirm).getByText("Descartar alterações?")).toBeInTheDocument();
    await user.click(within(confirm).getByRole("button", { name: "Continuar editando" }));
    expect(screen.getByRole("dialog", { name: /Cargos e permissões/ })).toBeInTheDocument();

    await user.keyboard("{Escape}");
    await user.click(
      await within(await screen.findByRole("alertdialog")).findByRole("button", {
        name: "Descartar",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("sem alterações o Esc fecha direto", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", { signedIn: true, seed: seedRoles });
    await openRoles(user);
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("diálogo de convites", () => {
  const seedInvite = seedRoles;

  it("cria, copia com feedback 'Copiado' e só revoga depois de confirmar", async () => {
    const user = userEvent.setup();
    const deleted: string[] = [];
    server.use(
      http.delete("*/api/invites/:code", ({ params }) => {
        deleted.push(String(params.code));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        seedInvite(s);
        const g = s.guilds[0];
        if (g) g.permissions |= Permission.CREATE_INVITE;
      },
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Convidar pessoas/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("heading", { name: "Convidar pessoas" })).toBeInTheDocument();

    server.use(
      http.get("*/api/guilds/:guildId/invites", () =>
        HttpResponse.json([
          {
            code: "abcd2345",
            guild_id: "g1",
            creator_id: ME,
            uses: 1,
            max_uses: 5,
            expires_at: null,
            created_at: "2026-10-30T12:00:00Z",
          },
        ]),
      ),
    );
    await user.click(within(dialog).getByRole("button", { name: "Criar convite" }));
    const copy = await within(dialog).findByRole("button", {
      name: "Copiar link do convite abcd2345",
    });
    await user.click(copy);
    expect(await within(dialog).findByText("Copiado")).toBeInTheDocument();
    expect(within(dialog).getByText(/1\/5/)).toBeInTheDocument();
    expect(within(dialog).getByText("não expira")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Revogar convite abcd2345" }));
    expect(deleted).toEqual([]); // ainda não: pede confirmação
    const confirm = await screen.findByRole("alertdialog");
    await user.click(within(confirm).getByRole("button", { name: "Revogar" }));
    await waitFor(() => expect(deleted).toEqual(["abcd2345"]));
    await waitFor(() =>
      expect(
        within(dialog).queryByRole("button", { name: "Copiar link do convite abcd2345" }),
      ).toBeNull(),
    );
  });

  it("valida o limite de usos inline", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        seedInvite(s);
        const g = s.guilds[0];
        if (g) g.permissions |= Permission.CREATE_INVITE;
      },
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Convidar pessoas/ }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Limite de usos"), "abc");
    await user.click(within(dialog).getByRole("button", { name: "Criar convite" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("número inteiro");
  });
});

describe("telas de estado", () => {
  it("servidor inexistente vira tela de estado com ação", async () => {
    await renderApp("/channels/nada", { signedIn: true, seed: () => {} });
    expect(
      await screen.findByRole("heading", { name: "Servidor não encontrado" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Ir para o início/ })).toHaveAttribute("href", "/");
  });

  it("canal inexistente oferece escolher outro", async () => {
    await renderApp("/channels/g1/zzz", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa"));
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Canal não encontrado" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Escolher outro canal/ })).toBeInTheDocument();
  });

  it("convite inválido: tela com mensagem e CTA", async () => {
    await renderApp("/invite/naoexiste", { signedIn: true });
    expect(
      await screen.findByRole("heading", { name: "Convite indisponível" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("não existe");
    expect(screen.getByRole("link", { name: /Ir para o início/ })).toBeInTheDocument();
  });

  it("quem já é membro vê 'Você já está neste servidor' e abre o servidor, sem gastar o convite", async () => {
    const app = await renderApp("/invite/abcd2345", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa"));
        s.invites.abcd2345 = { guild: guild("g1", "Alfa") };
      },
    });
    expect(
      await screen.findByRole("heading", { name: "Você já está neste servidor" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Abrir Alfa/ })).toHaveAttribute(
      "href",
      "/channels/g1",
    );
    expect(
      app.state.requests.some((r) => r.method === "POST" && r.path.includes("/invites/")),
    ).toBe(false);
  });

  it("erro de rede/5xx: 'Tentar de novo' chama a recarga; 403 vira 'Sem permissão' sem retry", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const network = renderState(new Error("falhou"), retry);
    await network;
    expect(
      await screen.findByRole("heading", { name: "Não foi possível carregar" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("403 vira 'Sem permissão' e não oferece tentar de novo", async () => {
    await renderState(new ApiError(403, "sem acesso"), vi.fn());
    expect(await screen.findByRole("heading", { name: "Sem permissão" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Tentar de novo/ })).toBeNull();
    expect(screen.getByRole("link", { name: /Ir para o início/ })).toBeInTheDocument();
  });

  it("home sem servidor: cartões de ação abrem o diálogo na aba certa", async () => {
    const user = userEvent.setup();
    await renderApp("/", { signedIn: true, seed: () => {} });
    await user.click(await screen.findByRole("button", { name: "Entrar com convite" }));
    expect(
      await screen.findByRole("tab", { name: "Entrar com convite", selected: true }),
    ).toBeTruthy();
  });
});

describe("ErrorBoundary", () => {
  it("mostra a tela amigável, sem stack, quando um filho quebra", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const Boom = () => {
      throw new Error("segredo-interno-do-stack");
    };
    const { container } = renderBoundary(<Boom />);
    expect(screen.getByRole("heading", { name: "Algo deu errado" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Recarregar a página" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ir para o início" })).toHaveAttribute("href", "/");
    expect(container.textContent).not.toContain("segredo-interno-do-stack");
    spy.mockRestore();
  });
});

import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/theme-provider";

function renderBoundary(ui: ReactNode) {
  return render(
    <ThemeProvider>
      <ErrorBoundary>{ui}</ErrorBoundary>
    </ThemeProvider>,
  );
}

describe("DMs: prévia de horário e busca", () => {
  const me = recipient(ME, "ana");
  const bia = recipient("50", "bia", "Bia Souza");
  const caio = recipient("60", "caio");
  const at = (iso: string) => String(BigInt(Date.parse(iso) - Date.UTC(2026, 0, 1)) << 22n);

  const seed = (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa"));
    s.dms = [
      dm("1100", [me, bia], { last_message_id: at("2026-10-30T14:05:00Z") }),
      dm("1200", [me, caio], { last_message_id: at("2026-10-29T10:00:00Z") }),
    ];
  };

  it("mostra a hora da última mensagem (do Snowflake) em cada conversa", async () => {
    await renderApp("/channels/@me", { signedIn: true, seed });
    const nav = await screen.findByRole("navigation", { name: "Conversas" });
    const times = await waitFor(() => {
      const t = nav.querySelectorAll("time");
      expect(t).toHaveLength(2);
      return [...t].map((e) => e.getAttribute("datetime"));
    });
    expect(times).toEqual(["2026-10-30T14:05:00.000Z", "2026-10-29T10:00:00.000Z"]);
  });

  it("busca filtra a lista e mostra o vazio da busca", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/@me", { signedIn: true, seed });
    const nav = await screen.findByRole("navigation", { name: "Conversas" });
    await within(nav).findAllByRole("link");
    await user.type(screen.getByRole("searchbox", { name: "Buscar conversas" }), "caio");
    expect(within(nav).getAllByRole("link")).toHaveLength(1);
    await user.clear(screen.getByRole("searchbox", { name: "Buscar conversas" }));
    await user.type(screen.getByRole("searchbox", { name: "Buscar conversas" }), "zzz");
    expect(within(nav).queryAllByRole("link")).toHaveLength(0);
    expect(within(nav).getByText(/Nenhuma conversa com/)).toBeInTheDocument();
  });

  it("sem conversas: ilustração e ação na própria lista", async () => {
    await renderApp("/channels/@me", { signedIn: true, seed: () => {} });
    const nav = await screen.findByRole("navigation", { name: "Conversas" });
    expect(await within(nav).findByText("Nenhuma conversa ainda")).toBeInTheDocument();
    expect(within(nav).getByRole("button", { name: /Nova conversa/ })).toBeInTheDocument();
  });
});

async function renderState(error: unknown, onRetry: () => void) {
  const root = createRootRoute({ component: () => <ErrorState error={error} onRetry={onRetry} /> });
  const router = createRouter({
    routeTree: root,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  return render(
    <ThemeProvider>
      <RouterProvider router={router} />
    </ThemeProvider>,
  );
}
