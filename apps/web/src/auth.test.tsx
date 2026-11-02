import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";

describe("telas de entrada", () => {
  it("tem um único h1, landmark main e a marca", async () => {
    await renderApp("/login");
    await screen.findByRole("heading", { name: "Entrar" });
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByAltText("SPOOK")).toBeInTheDocument();
  });

  it("alterna entre login e cadastro", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/login");
    await user.click(await screen.findByRole("link", { name: "Cadastre-se" }));
    expect(await screen.findByRole("heading", { name: "Criar conta" })).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Entrar" }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("mostra e oculta a senha com um botão acessível", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    const field = await screen.findByLabelText("Senha");
    expect(field).toHaveAttribute("type", "password");
    expect(field).toHaveAttribute("autocomplete", "current-password");
    await user.click(screen.getByRole("button", { name: "Mostrar senha" }));
    expect(field).toHaveAttribute("type", "text");
    const hide = screen.getByRole("button", { name: "Ocultar senha" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
  });

  it("valida inline ao sair do campo e liga o erro via aria-describedby", async () => {
    const user = userEvent.setup();
    await renderApp("/register");
    const email = await screen.findByLabelText("E-mail");
    await user.type(email, "nao-e-email");
    await user.tab();
    const msg = await screen.findByText("E-mail inválido.");
    expect(email).toHaveAttribute("aria-invalid", "true");
    expect(email).toHaveAttribute("aria-describedby", msg.closest("[id]")?.id);
    expect(screen.getByLabelText("Nome de usuário")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Senha")).toHaveAttribute("autocomplete", "new-password");
  });

  it("envio inválido leva o foco ao primeiro campo com erro", async () => {
    const user = userEvent.setup();
    await renderApp("/register");
    await user.click(await screen.findByRole("button", { name: "Criar conta" }));
    await waitFor(() => expect(screen.getByLabelText("E-mail")).toHaveFocus());
  });

  it("erro de credencial aparece num bloco de alerta", async () => {
    const user = userEvent.setup();
    await renderApp("/login");
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "errada");
    await user.keyboard("{Enter}");
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("E-mail ou senha incorretos.");
    expect(alert.querySelector("svg")).not.toBeNull();
  });

  it("durante o envio desabilita os campos e não duplica a requisição", async () => {
    const user = userEvent.setup();
    let calls = 0;
    await renderApp("/login");
    server.use(
      http.post("*/api/auth/login", async () => {
        calls++;
        await delay(150);
        return HttpResponse.json(
          { title: "401", status: 401, detail: "x", errors: [] },
          { status: 401 },
        );
      }),
    );
    await user.type(await screen.findByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "qualquer-coisa");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    const button = await screen.findByRole("button", { name: "Entrar" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(screen.getByLabelText("E-mail")).toBeDisabled();
    await user.click(button);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(calls).toBe(1);
    expect(screen.getByLabelText("E-mail")).toBeEnabled();
  });

  it("erro inesperado do servidor também vira alerta no formulário", async () => {
    const user = userEvent.setup();
    await renderApp("/register");
    server.use(
      http.post("*/api/auth/register", () =>
        HttpResponse.json({ title: "500", status: 500, detail: "x", errors: [] }, { status: 500 }),
      ),
    );
    await user.type(await screen.findByLabelText("E-mail"), "novo@spook.dev");
    await user.type(screen.getByLabelText("Nome de usuário"), "novo_user");
    await user.type(screen.getByLabelText("Senha"), "senha-forte-123");
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Erro no servidor");
  });
});

describe("convite sem sessão", () => {
  it("login mostra o aviso do convite e preserva o redirect nas duas ações", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/invite/abcd2345");
    const banner = await screen.findByRole("region", { name: "Convite recebido" });
    expect(banner).toHaveTextContent("Você recebeu um convite");
    const signUp = screen.getByRole("link", { name: "Criar conta" });
    expect(signUp).toHaveAttribute(
      "href",
      expect.stringContaining("redirect=%2Finvite%2Fabcd2345"),
    );
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("aria-current", "page");
    await user.click(signUp);
    expect(await screen.findByRole("heading", { name: "Criar conta" })).toBeInTheDocument();
    expect(router.state.location.search).toEqual({ redirect: "/invite/abcd2345" });
    expect(screen.getByRole("region", { name: "Convite recebido" })).toBeInTheDocument();
  });

  it("login comum não mostra o aviso", async () => {
    await renderApp("/login");
    await screen.findByRole("heading", { name: "Entrar" });
    expect(screen.queryByRole("region", { name: "Convite recebido" })).not.toBeInTheDocument();
  });
});

describe("404", () => {
  it("deslogado: mostra a página e volta ao início", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/rota-que-nao-existe");
    expect(
      await screen.findByRole("heading", { level: 1, name: "Página não encontrada" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("link", { name: "Voltar ao início" }));
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
  });

  it("logado: usa o mesmo componente", async () => {
    await renderApp("/rota-que-nao-existe", { signedIn: true });
    expect(
      await screen.findByRole("heading", { name: "Página não encontrada" }),
    ).toBeInTheDocument();
  });
});
