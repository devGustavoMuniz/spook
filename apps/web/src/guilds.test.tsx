import { Permission } from "@spook/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { channel, guild, ME, member, role } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const MANAGE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_CHANNELS;

describe("servidores", () => {
  it("sem servidores mostra o estado vazio e cria um servidor com geral/Geral", async () => {
    const user = userEvent.setup();
    const { router, state } = await renderApp("/", { signedIn: true });
    expect(await screen.findByText("Você ainda não está em nenhum servidor")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Criar servidor" }));
    await user.type(await screen.findByLabelText("Nome do servidor"), "Meu Grupo");
    await user.click(screen.getByRole("button", { name: "Criar servidor", hidden: false }));

    // entra no canal de texto "geral"; o de voz "Geral" só aparece, sem link
    expect(await screen.findByRole("heading", { name: "geral" })).toBeInTheDocument();
    expect(router.state.location.pathname).toMatch(/^\/channels\/\d+\/[\w-]+$/);
    expect(state.guilds).toHaveLength(1);
    const nav = screen.getByRole("navigation", { name: "Canais" });
    expect(within(nav).getByRole("link", { name: /geral/ })).toBeInTheDocument();
    expect(within(nav).getAllByText("Geral").length).toBeGreaterThan(0);
    expect(within(nav).queryByRole("link", { name: /Geral/ })).toBeNull(); // o de voz é um botão
    expect(screen.getByRole("link", { name: "Meu Grupo" })).toBeInTheDocument();
  });

  it("valida o nome do servidor", async () => {
    const user = userEvent.setup();
    await renderApp("/", { signedIn: true });
    await user.click(await screen.findByRole("button", { name: "Criar servidor" }));
    await user.type(await screen.findByLabelText("Nome do servidor"), "a");
    await user.click(screen.getByRole("button", { name: "Criar servidor", hidden: false }));
    expect(await screen.findByText("Use de 2 a 100 caracteres.")).toBeInTheDocument();
  });

  it("/ abre o último servidor visitado e troca de servidor pela barra", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa"), guild("g2", "Beta"));
        s.guilds[1]?.channels?.push(channel("g2-extra", "novidades", 3, 0, "g2-cat"));
        s.members.g1 = [member(ME, "ana")];
        s.members.g2 = [member(ME, "ana")];
      },
    });
    // sem histórico: primeiro servidor, primeiro canal de texto
    expect(await screen.findByRole("heading", { name: "geral" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/channels/g1/g1-txt");
    expect(screen.queryByRole("link", { name: /novidades/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("link", { name: "Beta" }));
    expect(await screen.findByRole("link", { name: /novidades/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/channels/g2/g2-txt");
    expect(screen.getByRole("button", { name: /Menu do servidor Beta/ })).toBeInTheDocument();
  });

  it("servidor inexistente (ou de onde saí) mostra aviso", async () => {
    await renderApp("/channels/nao-existe", {
      signedIn: true,
      seed: (s) => s.guilds.push(guild("g1", "Alfa")),
    });
    expect(await screen.findByText("Servidor não encontrado")).toBeInTheDocument();
  });
});

describe("lista de canais e permissões", () => {
  const channels = [
    channel("c1", "avisos", 0),
    channel("cat", "Texto", 1, 2),
    channel("a", "a", 2, 0, "cat"),
    channel("b", "b", 3, 0, "cat"),
    channel("v", "sala", 4, 1, "cat"),
  ];

  it("sem MANAGE_CHANNELS não há ações de gestão", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => s.guilds.push(guild("g1", "Alfa", { channels })),
    });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    expect(within(nav).getByRole("link", { name: "avisos" })).toBeInTheDocument();
    // o canal de voz é um botão (bloqueado, sem CONNECT); o menu dos canais de texto só tem
    // notificações (silenciar e nível), nenhuma ação de gestão
    await user.click(within(nav).getByRole("button", { name: "Opções de avisos" }));
    expect(
      await screen.findByRole("menuitem", { name: /Silenciar este canal/ }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /Renomear|Excluir/ })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Menu do servidor/ }));
    expect(screen.queryByRole("menuitem", { name: /Criar canal/ })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: /Configurações do servidor/ }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Convidar pessoas/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Sair do servidor/ })).toBeInTheDocument();
  });

  it("canais de voz são botões (não links); categorias agrupam os filhos", async () => {
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => s.guilds.push(guild("g1", "Alfa", { channels })),
    });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    const cat = within(nav).getByRole("region", { name: "Categoria Texto" });
    expect(
      within(cat)
        .getAllByRole("link")
        .map((l) => l.textContent),
    ).toEqual(["a", "b"]);
    expect(within(cat).queryByRole("link", { name: /sala/ })).not.toBeInTheDocument();
    expect(within(cat).getByText("sala")).toBeInTheDocument();
  });

  it("com MANAGE_CHANNELS reordena por botões e envia as posições", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => s.guilds.push(guild("g1", "Alfa", { permissions: MANAGE, channels })),
    });
    await screen.findByRole("navigation", { name: "Canais" });
    await user.click(screen.getByRole("button", { name: "Opções de b" }));
    await user.click(await screen.findByRole("menuitem", { name: /Mover para cima/ }));
    await waitFor(() => {
      const req = state.requests.find((r) => r.path.endsWith("/channels/positions"));
      expect(req?.body).toEqual({
        channels: [
          { id: "c1", position: 0, parent_id: null },
          { id: "cat", position: 1, parent_id: null },
          { id: "b", position: 2, parent_id: "cat" },
          { id: "a", position: 3, parent_id: "cat" },
          { id: "v", position: 4, parent_id: "cat" },
        ],
      });
    });
    // o primeiro filho não pode subir mais
    const nav = screen.getByRole("navigation", { name: "Canais" });
    const cat = within(nav).getByRole("region", { name: "Categoria Texto" });
    await waitFor(() =>
      expect(
        within(cat)
          .getAllByRole("link")
          .map((l) => l.textContent),
      ).toEqual(["b", "a"]),
    );
    await user.click(screen.getByRole("button", { name: "Opções de b" }));
    expect(await screen.findByRole("menuitem", { name: /Mover para cima/ })).toHaveAttribute(
      "aria-disabled",
      "true",
    );
  });
});

describe("cargos e hierarquia", () => {
  const roles = [
    role("adm", "Admin", 5, { color: 0xff0000 }),
    role("mod", "Moderador", 3),
    role("vip", "VIP", 1, { color: 0x00ff00 }),
    role("g1", "@everyone", 0, { is_everyone: true }),
  ];

  it("lista do mais alto ao mais baixo e marca o que está acima do meu cargo", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(
          guild("g1", "Alfa", {
            roles,
            my_role_ids: ["mod"],
            permissions: Permission.VIEW_CHANNEL | Permission.MANAGE_ROLES,
          }),
        );
        s.members.g1 = [member(ME, "ana", ["mod"])];
      },
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Cargos" }));
    const list = await screen.findByRole("list", { name: "Cargos" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual([
      expect.stringContaining("Admin"),
      expect.stringContaining("Moderador"),
      expect.stringContaining("VIP"),
      expect.stringContaining("@everyone"),
    ]);
    expect(within(items[0] as HTMLElement).getByText(/Acima do seu cargo/)).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText(/Acima do seu cargo/)).toBeInTheDocument(); // empate
    expect(
      within(items[2] as HTMLElement).queryByText(/Acima do seu cargo/),
    ).not.toBeInTheDocument();

    // cargo acima: formulário travado
    expect(await screen.findByRole("note")).toHaveTextContent(/acima do seu/);
    expect(screen.getByLabelText("Nome do cargo")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Salvar cargo" })).toBeDisabled();

    // cargo abaixo: editável
    await user.click(within(items[2] as HTMLElement).getByRole("button"));
    expect(screen.getByLabelText("Nome do cargo")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Excluir cargo" })).toBeEnabled();
    // não concede o que não tem (ex.: expulsar)
    expect(screen.getByRole("switch", { name: "Expulsar membros" })).toBeDisabled();
    expect(screen.getByRole("switch", { name: "Gerenciar cargos" })).toBeEnabled();
  });
});

describe("membros", () => {
  it("expulsar só aparece com KICK_MEMBERS e para quem está abaixo", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(
          guild("g1", "Alfa", {
            roles: [
              role("adm", "Admin", 5),
              role("mod", "Mod", 3),
              role("g1", "@everyone", 0, { is_everyone: true }),
            ],
            my_role_ids: ["mod"],
            permissions: Permission.VIEW_CHANNEL | Permission.KICK_MEMBERS,
          }),
        );
        s.members.g1 = [
          member(ME, "ana", ["mod"]),
          member("2", "bia"),
          member("3", "chefe", ["adm"]),
        ];
      },
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    expect(within(panel).getByRole("button", { name: "Opções de bia" })).toBeInTheDocument();
    // eu mesmo não tenho menu; os demais têm "Enviar mensagem" (Fase 4), mas "Expulsar" só vale para quem está abaixo
    expect(within(panel).queryByRole("button", { name: "Opções de ana" })).not.toBeInTheDocument();
    await user.click(within(panel).getByRole("button", { name: "Opções de chefe" }));
    expect(await screen.findByRole("menuitem", { name: "Enviar mensagem" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Expulsar" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    expect(await screen.findByRole("menuitem", { name: "Expulsar" })).toBeInTheDocument();
  });
});
