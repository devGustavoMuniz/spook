import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { channel, guild, ME, member } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";
import { FakeXhr } from "@/test/xhr";

const CORRECT = "senha-correta-1";
const NEW_PASSWORD = "outra-senha-9";

beforeEach(() => {
  localStorage.clear();
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const open = (backend: Parameters<typeof renderApp>[1] = { signedIn: true }) =>
  renderApp("/settings/profile", backend);

describe("trocar senha", () => {
  it("valida no cliente: confirmação diferente e nova igual à atual", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    await user.type(await screen.findByLabelText("Senha atual"), CORRECT);
    await user.type(screen.getByLabelText("Nova senha"), NEW_PASSWORD);
    await user.type(screen.getByLabelText("Repita a nova senha"), "diferente-123");
    await user.click(screen.getByRole("button", { name: "Trocar senha" }));
    expect(await screen.findByText("As senhas não coincidem.")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Nova senha"));
    await user.type(screen.getByLabelText("Nova senha"), CORRECT);
    await user.clear(screen.getByLabelText("Repita a nova senha"));
    await user.type(screen.getByLabelText("Repita a nova senha"), CORRECT);
    await user.click(screen.getByRole("button", { name: "Trocar senha" }));
    expect(
      await screen.findByText("A nova senha deve ser diferente da atual."),
    ).toBeInTheDocument();
    expect(state.account.passwordChanges).toHaveLength(0);
  });

  it("senha atual errada mostra o erro no campo; certa troca e avisa", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    await user.type(await screen.findByLabelText("Senha atual"), "errada-123");
    await user.type(screen.getByLabelText("Nova senha"), NEW_PASSWORD);
    await user.type(screen.getByLabelText("Repita a nova senha"), NEW_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Trocar senha" }));
    expect(await screen.findByText("Senha atual incorreta")).toBeInTheDocument();

    await user.clear(screen.getByLabelText("Senha atual"));
    await user.type(screen.getByLabelText("Senha atual"), CORRECT);
    await user.click(screen.getByRole("button", { name: "Trocar senha" }));
    await waitFor(() =>
      expect(state.account.passwordChanges).toEqual([
        { current_password: CORRECT, new_password: NEW_PASSWORD },
      ]),
    );
    expect(
      await screen.findByText(/Os outros dispositivos foram desconectados/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Senha atual")).toHaveValue("");
  });
});

describe("trocar e-mail com confirmação de senha", () => {
  it("o 403 abre 'Confirme sua senha'; senha errada fica no diálogo; certa repete a ação", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    const email = await screen.findByLabelText("E-mail");
    await user.clear(email);
    await user.type(email, "novo@spook.dev");
    await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirme sua senha" });
    await user.type(within(dialog).getByLabelText("Senha"), "errada-123");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    expect(await within(dialog).findByText("Senha incorreta.")).toBeInTheDocument();
    expect(state.account.emailChanges).toHaveLength(0);

    await user.clear(within(dialog).getByLabelText("Senha"));
    await user.type(within(dialog).getByLabelText("Senha"), CORRECT);
    await user.click(within(dialog).getByRole("button", { name: "Confirmar" }));

    await waitFor(() => expect(state.account.emailChanges).toEqual(["novo@spook.dev"]));
    expect(await screen.findByText("E-mail alterado.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Confirme sua senha" })).toBeNull();
  });

  it("cancelar o diálogo não troca nada nem mostra erro", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    const email = await screen.findByLabelText("E-mail");
    await user.clear(email);
    await user.type(email, "novo@spook.dev");
    await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));
    const dialog = await screen.findByRole("dialog", { name: "Confirme sua senha" });
    await user.click(within(dialog).getByRole("button", { name: "Cancelar" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Confirme sua senha" })).toBeNull(),
    );
    expect(state.account.emailChanges).toHaveLength(0);
    expect(screen.queryByText("E-mail alterado.")).toBeNull();
  });

  it("já confirmado (10 min): troca direto, e e-mail em uso vira erro no campo", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    state.account.confirmed = true;
    const email = await screen.findByLabelText("E-mail");
    await user.clear(email);
    await user.type(email, "ocupado@spook.dev");
    await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));
    expect(await screen.findByText("E-mail já cadastrado.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Confirme sua senha" })).toBeNull();
  });
});

describe("excluir conta", () => {
  async function openDialog(user: ReturnType<typeof userEvent.setup>) {
    await user.click(await screen.findByRole("button", { name: "Excluir minha conta" }));
    return screen.findByRole("dialog", { name: "Excluir conta" });
  }

  it("só habilita depois de digitar o username e a senha; exclui e volta ao login", async () => {
    const user = userEvent.setup();
    const { state, router } = await open();
    const dialog = await openDialog(user);
    const submit = within(dialog).getByRole("button", { name: "Excluir conta" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/Digite ana para confirmar/), "outra");
    await user.type(within(dialog).getByLabelText("Senha"), CORRECT);
    expect(submit).toBeDisabled();
    await user.clear(within(dialog).getByLabelText(/Digite ana para confirmar/));
    await user.type(within(dialog).getByLabelText(/Digite ana para confirmar/), "ana");
    expect(submit).toBeEnabled();
    await user.click(submit);
    await waitFor(() => expect(state.account.deletes).toEqual(["1"]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
  });

  it("senha errada fica no diálogo", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText(/Digite ana/), "ana");
    await user.type(within(dialog).getByLabelText("Senha"), "errada-123");
    await user.click(within(dialog).getByRole("button", { name: "Excluir conta" }));
    expect(await within(dialog).findByText("Senha incorreta.")).toBeInTheDocument();
    expect(state.account.deletes).toHaveLength(0);
  });

  it("dono de servidor: lista os servidores e não exclui", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    state.account.ownedGuilds = [{ id: "g1", name: "Meu Servidor" }];
    const dialog = await openDialog(user);
    await user.type(within(dialog).getByLabelText(/Digite ana/), "ana");
    await user.type(within(dialog).getByLabelText("Senha"), CORRECT);
    await user.click(within(dialog).getByRole("button", { name: "Excluir conta" }));
    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("Meu Servidor");
    expect(alert).toHaveTextContent(/Transfira a posse ou exclua/);
    expect(state.account.deletes).toHaveLength(0);
  });
});

describe("perfil: bio, pronomes e banner", () => {
  it("salva bio e pronomes e mostra o contador", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    await user.type(await screen.findByLabelText("Pronomes"), "ela/dela");
    await user.type(screen.getByLabelText("Bio"), "Estudando Go");
    expect(screen.getByText("12/190")).toBeInTheDocument();
    await user.click(screen.getAllByRole("button", { name: "Salvar" })[1] as HTMLElement);
    await waitFor(() =>
      expect(state.patches).toContainEqual({ bio: "Estudando Go", pronouns: "ela/dela" }),
    );
    expect(await screen.findByText("Perfil atualizado.")).toBeInTheDocument();
  });

  it("banner por cor: usa a cor e remove", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    const color = (await screen.findByLabelText("Cor do banner")) as HTMLInputElement;
    // jsdom: input type=color aceita value direto
    fireEvent.change(color, { target: { value: "#ff8800" } });
    await user.click(screen.getByRole("button", { name: "Usar cor" }));
    await waitFor(() => expect(state.patches).toContainEqual({ banner_color: 0xff8800 }));
    await user.click(await screen.findByRole("button", { name: "Remover" }));
    await waitFor(() => expect(state.patches).toContainEqual({ remove_banner: true }));
  });

  it("banner por imagem: recusa tipo inválido sem pedir upload", async () => {
    const { state } = await open();
    const input = (await screen.findByLabelText("Enviar imagem de banner")) as HTMLInputElement;
    fireEvent.change(input, {
      target: { files: [new File(["x"], "a.svg", { type: "image/svg+xml" })] },
    });
    expect(await screen.findByText("Use uma imagem PNG, JPEG, WebP ou GIF.")).toBeInTheDocument();
    expect(state.account.bannerUploads).toHaveLength(0);
  });

  it("banner por imagem: pede o upload, envia e grava a chave", async () => {
    const user = userEvent.setup();
    const { state } = await open();
    const input = (await screen.findByLabelText("Enviar imagem de banner")) as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array(100)], "b.gif", { type: "image/gif" }));
    await waitFor(() => expect(FakeXhr.all).toHaveLength(1));
    expect(state.account.bannerUploads).toEqual([{ content_type: "image/gif", size: 100 }]);
    expect(FakeXhr.all[0]?.headers["Content-Type"]).toBe("image/gif");
    FakeXhr.all[0]?.finish(200);
    await waitFor(() => expect(state.patches).toContainEqual({ banner_key: "banners/1/1.png" }));
    expect(await screen.findByRole("img", { name: "Prévia do banner" })).toBeInTheDocument();
  });
});

describe("cartão de perfil", () => {
  const path = "/channels/g1/g1-txt";
  const seed = (extra: Record<string, unknown>) => (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { channels: [channel("g1-txt", "geral", 0)] }));
    s.members.g1 = [member(ME, "ana"), { ...member("50", "bia"), ...extra }];
  };

  it("mostra bio, pronomes e banner com imagem", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: seed({
        bio: "Gosto de café",
        pronouns: "ela/dela",
        banner_url: "https://s3.test/banners/50/1.gif",
      }),
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(await within(panel).findByRole("button", { name: "Ver perfil de bia" }));
    const card = await screen.findByRole("dialog", { name: "Perfil de bia" });
    expect(within(card).getByText("Gosto de café")).toBeInTheDocument();
    expect(within(card).getByText(/ela\/dela/)).toBeInTheDocument();
    const banner = within(card).getByTestId("profile-banner");
    expect(banner.querySelector("img")).toHaveAttribute("src", "https://s3.test/banners/50/1.gif");
  });

  it("banner de cor sólida e conta removida", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa", { channels: [channel("g1-txt", "geral", 0)] }));
        s.members.g1 = [
          member(ME, "ana"),
          { ...member("60", "removido_60"), banner_color: 0xff8800 },
        ];
      },
    });
    const panel = await screen.findByRole("complementary", { name: "Membros" });
    await user.click(
      await within(panel).findByRole("button", { name: "Ver perfil de Usuário removido" }),
    );
    const card = await screen.findByRole("dialog", { name: "Perfil de Usuário removido" });
    expect(within(card).getByTestId("profile-banner")).toHaveStyle({
      background: "rgb(255, 136, 0)",
    });
  });
});
