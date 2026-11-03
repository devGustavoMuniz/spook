import { Permission } from "@spook/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { channel, guild, ME, member, role } from "@/test/fixtures";
import { renderApp } from "@/test/render";

const MANAGE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES | Permission.MANAGE_CHANNELS;
const roles = [
  role("adm", "Admin", 5),
  role("mod", "Mod", 3),
  role("vip", "VIP", 1),
  role("g1", "@everyone", 0, { is_everyone: true }),
];
const channels = [channel("c1", "avisos", 0), channel("v1", "sala", 1, 1)];

const seed = (s: import("@/test/server").Backend["state"]) => {
  s.guilds.push(
    guild("g1", "Alfa", { roles, channels, my_role_ids: ["mod"], permissions: MANAGE }),
  );
  s.members.g1 = [member(ME, "ana", ["mod"]), member("2", "bia")];
};

async function openEditor(user: ReturnType<typeof userEvent.setup>, name = "avisos") {
  const nav = await screen.findByRole("navigation", { name: "Canais" });
  await user.click(within(nav).getByRole("button", { name: `Opções de ${name}` }));
  await user.click(await screen.findByRole("menuitem", { name: "Permissões" }));
  return await screen.findByRole("dialog", { name: /Permissões de/ });
}

describe("editor de permissões do canal", () => {
  it("sem MANAGE_CHANNELS o menu não oferece Permissões", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(
          guild("g1", "Alfa", { roles, channels, permissions: Permission.VIEW_CHANNEL }),
        );
        s.members.g1 = [member(ME, "ana")];
      },
    });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    await user.click(within(nav).getByRole("button", { name: "Opções de avisos" }));
    expect(screen.queryByRole("menuitem", { name: "Permissões" })).not.toBeInTheDocument();
  });

  it("torna o canal privado, libera um cargo e salva as regras", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", { signedIn: true, seed });
    const dialog = await openEditor(user);
    const privateSwitch = await within(dialog).findByRole("switch", { name: "Canal privado" });
    expect(privateSwitch).not.toBeChecked();
    await user.click(privateSwitch);
    expect(privateSwitch).toBeChecked();
    expect(within(dialog).getByText("Ninguém liberado ainda.")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("combobox", { name: "Liberar cargo" }));
    await user.click(await screen.findByRole("option", { name: "VIP" }));
    const viewers = within(dialog).getByRole("list", { name: "Quem pode entrar" });
    expect(within(viewers).getByText("VIP")).toBeInTheDocument();

    await user.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(state.moderation.overwrites.c1).toEqual(
        expect.arrayContaining([
          { type: "role", target_id: "g1", allow: 0, deny: Permission.VIEW_CHANNEL },
          { type: "role", target_id: "vip", allow: Permission.VIEW_CHANNEL, deny: 0 },
        ]),
      ),
    );
  });

  it("três estados por permissão, com teclado, e só as do tipo do canal", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", { signedIn: true, seed });
    const dialog = await openEditor(user);
    const rows = await within(dialog).findByRole("list", { name: "Permissões de @everyone" });
    expect(within(rows).queryByText("Falar")).not.toBeInTheDocument(); // canal de texto
    const group = within(rows).getByRole("radiogroup", { name: "Enviar mensagens" });
    const inherit = within(group).getByRole("radio", { name: "Herdar" });
    expect(inherit).toHaveAttribute("aria-checked", "true");
    inherit.focus();
    await user.keyboard("{ArrowRight}"); // Herdar -> Permitir
    expect(within(group).getByRole("radio", { name: "Permitir" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(group).getByRole("radio", { name: "Negar" }));
    expect(within(group).getByRole("radio", { name: "Negar" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));
    await waitFor(() =>
      expect(state.moderation.overwrites.c1).toEqual([
        { type: "role", target_id: "g1", allow: 0, deny: Permission.SEND_MESSAGES },
      ]),
    );
  });

  it("canal de voz mostra as permissões de voz e trava cargos acima do meu", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.moderation.overwrites.v1 = [
          { type: "role", target_id: "adm", allow: Permission.SPEAK, deny: 0 },
        ];
      },
    });
    const dialog = await openEditor(user, "sala");
    const list = await within(dialog).findByRole("list", { name: "Cargos e pessoas com regras" });
    await user.click(within(list).getByRole("button", { name: /Admin/ }));
    expect(within(list).getByText(/Acima do seu cargo/)).toBeInTheDocument();
    const rows = within(dialog).getByRole("list", { name: "Permissões de Admin" });
    expect(within(rows).getByText("Falar")).toBeInTheDocument();
    expect(within(rows).queryByText("Enviar mensagens")).not.toBeInTheDocument();
    for (const r of within(rows).getAllByRole("radio")) expect(r).toBeDisabled();
  });

  it("mostra o erro de hierarquia do servidor ao salvar", async () => {
    const user = userEvent.setup();
    await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.moderation.overwriteError = { status: 403, detail: "sem permissão" };
      },
    });
    const dialog = await openEditor(user);
    const group = await within(dialog).findByRole("radiogroup", { name: "Enviar mensagens" });
    await user.click(within(group).getByRole("radio", { name: "Negar" }));
    await user.click(within(dialog).getByRole("button", { name: "Salvar alterações" }));
    expect(await screen.findByText(/só pode editar cargos abaixo do seu/)).toBeInTheDocument();
  });
});
