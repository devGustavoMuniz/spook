import { Permission } from "@spook/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { guild, ME, member, role } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.CHANGE_NICKNAME;
const roles = [
  role("adm", "Admin", 5),
  role("mod", "Mod", 3),
  role("g1", "@everyone", 0, { is_everyone: true }),
];

function seedGuild(extra: number, opts: { channels?: boolean } = {}) {
  return (s: import("@/test/server").Backend["state"]) => {
    s.guilds.push(
      guild("g1", "Alfa", {
        roles,
        my_role_ids: ["mod"],
        permissions: BASE | extra,
        ...(opts.channels ? {} : {}),
      }),
    );
    s.members.g1 = [member(ME, "ana", ["mod"]), member("2", "bia"), member("3", "chefe", ["adm"])];
  };
}

describe("banir", () => {
  it("só aparece com BAN_MEMBERS e para quem está abaixo; pede o motivo e envia", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", {
      signedIn: true,
      seed: seedGuild(Permission.BAN_MEMBERS),
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    await user.click(within(panel).getByRole("button", { name: "Opções de chefe" }));
    expect(screen.queryByRole("menuitem", { name: "Banir" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");

    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    await user.click(await screen.findByRole("menuitem", { name: "Banir" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Banir bia?")).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Motivo (opcional)"), "spam de links");
    await user.click(within(dialog).getByRole("button", { name: "Banir" }));
    await waitFor(() =>
      expect(state.moderation.banBodies).toEqual([{ userId: "2", reason: "spam de links" }]),
    );
  });

  it("sem BAN_MEMBERS não há ação nem aba de banimentos", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", { signedIn: true, seed: seedGuild(Permission.KICK_MEMBERS) });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    expect(await screen.findByRole("menuitem", { name: "Expulsar" })).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Banir" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: /Menu do servidor/ }));
    expect(screen.queryByRole("menuitem", { name: /Banimentos/ })).not.toBeInTheDocument();
  });
});

describe("aba Banimentos", () => {
  it("lista motivo e quem baniu, e desbana com confirmação", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        seedGuild(Permission.BAN_MEMBERS)(s);
        s.moderation.bans.g1 = [
          {
            guild_id: "g1",
            user_id: "9",
            username: "intruso",
            reason: "spam",
            banned_by: ME,
            banned_by_username: "ana",
            created_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
          },
        ];
      },
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Banimentos/ }));
    const list = await screen.findByRole("list", { hidden: false });
    expect(await within(list).findByText(/Motivo: spam/)).toBeInTheDocument();
    expect(within(list).getByText(/Por @ana/)).toBeInTheDocument();

    await user.click(within(list).getByRole("button", { name: "Desbanir intruso" }));
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Desbanir" }));
    await waitFor(() => expect(state.moderation.unbans).toEqual(["9"]));
    expect(await screen.findByText("Ninguém está banido deste servidor.")).toBeInTheDocument();
  });
});

describe("apelido", () => {
  it("o próprio membro altera pelo menu do servidor e o nome muda na lista", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", { signedIn: true, seed: seedGuild(0) });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    await user.click(screen.getByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: "Alterar apelido" }));
    const input = await screen.findByLabelText("Apelido");
    await user.type(input, "Anita");
    await user.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(state.moderation.nicks).toEqual([{ userId: ME, nick: "Anita" }]));
    expect(await within(panel).findByText("Anita")).toBeInTheDocument();
  });

  it("limita a 32 caracteres e o de outros exige MANAGE_NICKNAMES", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: seedGuild(Permission.MANAGE_NICKNAMES),
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await within(panel).findByText("bia");
    await user.click(within(panel).getByRole("button", { name: "Opções de bia" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mudar apelido" }));
    const input = await screen.findByLabelText("Apelido");
    await user.type(input, "x".repeat(33));
    expect(screen.getByText("33/32 caracteres")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeDisabled();
    await user.keyboard("{Escape}");
    // acima da hierarquia: sem a ação
    await user.click(within(panel).getByRole("button", { name: "Opções de chefe" }));
    expect(screen.queryByRole("menuitem", { name: "Mudar apelido" })).not.toBeInTheDocument();
  });
});

describe("registro de auditoria", () => {
  const entry = (id: string, action: string, changes: Record<string, unknown>, actor = "ana") => ({
    id,
    guild_id: "g1",
    actor: { id: ME, username: actor },
    action,
    target_type: "member",
    target_id: "2",
    reason: null,
    changes,
    created_at: new Date(Date.now() - 60_000).toISOString(),
  });

  it("mostra as ações em pt-br, filtra por ação e carrega mais", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        seedGuild(Permission.VIEW_AUDIT_LOG)(s);
        const many = Array.from({ length: 35 }, (_, i) =>
          entry(String(100 + i), "channel.create", { target_name: `canal-${i}` }),
        );
        s.moderation.audit.g1 = [
          ...many,
          { ...entry("200", "member.ban", { target_name: "bia" }), reason: "spam" },
        ];
      },
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Registro de auditoria/ }));
    expect(await screen.findByText(/baniu “bia”/)).toBeInTheDocument();
    expect(screen.getByText("Motivo: spam")).toBeInTheDocument();
    expect(screen.getByText(/criou o canal “canal-34”/)).toBeInTheDocument();
    expect(screen.queryByText(/canal-0”/)).not.toBeInTheDocument(); // fora da primeira página (30)
    await user.click(screen.getByRole("button", { name: "Carregar mais" }));
    expect(await screen.findByText(/criou o canal “canal-0”/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Carregar mais" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("combobox", { name: "Filtrar por ação" }));
    await user.click(await screen.findByRole("option", { name: "Membro banido" }));
    await waitFor(() => expect(screen.queryByText(/criou o canal/)).not.toBeInTheDocument());
    expect(screen.getByText(/baniu “bia”/)).toBeInTheDocument();
  });

  it("estado vazio e sem a permissão não há aba", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: seedGuild(Permission.VIEW_AUDIT_LOG),
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Registro de auditoria/ }));
    expect(await screen.findByText(/Nada registrado ainda/)).toBeInTheDocument();
  });

  it("sem VIEW_AUDIT_LOG o item não existe", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", { signedIn: true, seed: seedGuild(0) });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    expect(
      screen.queryByRole("menuitem", { name: /Registro de auditoria/ }),
    ).not.toBeInTheDocument();
  });
});

describe("convite com banimento", () => {
  it("mostra que a pessoa foi banida", async () => {
    const user = userEvent.setup();
    await renderApp("/invite/abcd2345", {
      signedIn: true,
      seed: (s) => {
        s.invites.abcd2345 = { guild: guild("g9", "Beta") };
        s.moderation.bannedInvites.add("abcd2345");
      },
    });
    await user.click(await screen.findByRole("button", { name: "Entrar no servidor" }));
    expect(await screen.findByTestId("join-error")).toHaveTextContent(/banido deste servidor/);
  });
});
