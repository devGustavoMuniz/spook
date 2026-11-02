import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";

describe("guarda de rotas", () => {
  it("sem sessão (401), / redireciona para /login", async () => {
    const { router } = await renderApp("/");
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("sem sessão, /settings/profile também vai para /login", async () => {
    const { router } = await renderApp("/settings/profile");
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("com sessão, /login redireciona para o início", async () => {
    const { router } = await renderApp("/login", { signedIn: true });
    expect(await screen.findByText("Você ainda não está em nenhum servidor")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("login", () => {
  it("entra com credenciais corretas e mostra o perfil", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/login");
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Você ainda não está em nenhum servidor")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });

  it("volta ao destino de ?redirect depois de entrar", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/login?redirect=/settings/profile");
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByLabelText("Nome de exibição")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/settings/profile");
  });

  it("mostra erro em pt-br com credenciais erradas", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "errada");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("E-mail ou senha incorretos.");
  });

  it("valida o formulário antes de enviar", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.click(await screen.findByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Informe o e-mail.")).toBeInTheDocument();
    expect(screen.getByText("Informe a senha.")).toBeInTheDocument();
  });

  it("exibe as frases da tela de entrada", async () => {
    await renderApp("/login");
    expect(
      await screen.findByText("Seus servidores, sua galera, num só lugar."),
    ).toBeInTheDocument();
    const features = screen.getByRole("list", { name: "Chat, Voz, Vídeo e Compartilhar tela" });
    expect(
      within(features)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["Chat", "Voz", "Vídeo", "Compartilhar tela"]);
  });
});

describe("cadastro", () => {
  it("409 de e-mail vira erro no campo e-mail", async () => {
    const user = userEvent.setup();
    await renderApp("/register");
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Nome de usuário"), "novo_nome");
    await user.type(screen.getByLabelText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(await screen.findByText("E-mail já cadastrado")).toBeInTheDocument();
    expect(screen.getByLabelText("E-mail")).toHaveAttribute("aria-invalid", "true");
  });

  it("409 de usuário vira erro no campo usuário", async () => {
    const user = userEvent.setup();
    await renderApp("/register");
    await user.type(await screen.findByLabelText("E-mail"), "outra@spook.dev");
    await user.type(screen.getByLabelText("Nome de usuário"), "ocupado");
    await user.type(screen.getByLabelText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(await screen.findByText("Nome de usuário já em uso")).toBeInTheDocument();
  });

  it("recusa usuário inválido e senha curta no cliente", async () => {
    const user = userEvent.setup();
    await renderApp("/register");
    await user.type(await screen.findByLabelText("E-mail"), "x@spook.dev");
    await user.type(screen.getByLabelText("Nome de usuário"), "Nome Inválido!");
    await user.type(screen.getByLabelText("Senha"), "curta");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(await screen.findByText(/letras minúsculas, números/)).toBeInTheDocument();
    expect(screen.getByText("A senha precisa ter ao menos 8 caracteres.")).toBeInTheDocument();
  });

  it("cadastra e entra direto", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/register");
    await user.type(await screen.findByLabelText("E-mail"), "novo@spook.dev");
    await user.type(screen.getByLabelText("Nome de usuário"), "Novo_User");
    await user.type(screen.getByLabelText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    expect(await screen.findByText("Você ainda não está em nenhum servidor")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/");
  });
});

describe("sessão", () => {
  it("logout encerra a sessão e volta ao login", async () => {
    const user = userEvent.setup();
    const { state, router } = await renderApp("/", { signedIn: true });
    await user.click(await screen.findByRole("button", { name: /Sair/ }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(state.logouts).toBe(1);
    expect(router.state.location.pathname).toBe("/login");
  });
});

describe("perfil", () => {
  it("edita o nome de exibição", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/profile", { signedIn: true });
    const input = await screen.findByLabelText("Nome de exibição");
    await user.type(input, "Ana Souza");
    const form = input.closest("form") as HTMLElement;
    await user.click(within(form).getByRole("button", { name: "Salvar" }));
    expect(await screen.findByText("Perfil atualizado.")).toBeInTheDocument();
    expect(state.patches).toEqual([{ display_name: "Ana Souza" }]);
  });

  it("recusa no cliente um arquivo que não é imagem aceita", async () => {
    const user = userEvent.setup({ applyAccept: false });
    const { state } = await renderApp("/settings/profile", { signedIn: true });
    await screen.findByText("Avatar");
    const file = new File(["texto"], "a.txt", { type: "text/plain" });
    await user.upload(document.getElementById("avatar-file") as HTMLInputElement, file);
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("PNG, JPEG, WebP ou GIF"),
    );
    expect(state.patches).toEqual([]);
  });
});

describe("e-mail inválido", () => {
  it("recusa formato de e-mail no cliente", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.type(await screen.findByLabelText("E-mail"), "sem-arroba");
    await user.type(screen.getByLabelText("Senha"), "x");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("E-mail inválido.")).toBeInTheDocument();
  });
});
