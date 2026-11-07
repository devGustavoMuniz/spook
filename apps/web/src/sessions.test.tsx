import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { renderApp } from "@/test/render";

beforeEach(() => localStorage.clear());

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

describe("Manter conectado", () => {
  it("o login vem marcado por padrão e envia remember=true", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/login");
    const box = await screen.findByRole("checkbox", { name: "Manter conectado" });
    expect(box).toBeChecked();
    await user.type(screen.getByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(state.auth.loginBodies).toHaveLength(1));
    expect(state.auth.loginBodies[0]).toMatchObject({ email: "ana@spook.dev", remember: true });
  });

  it("desmarcado, envia remember=false (checkbox acessível por teclado)", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/login");
    const box = await screen.findByRole("checkbox", { name: "Manter conectado" });
    expect(box).toHaveAccessibleDescription(/computadores compartilhados/);
    box.focus();
    await user.keyboard(" ");
    expect(box).not.toBeChecked();
    await user.type(screen.getByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    await waitFor(() => expect(state.auth.loginBodies).toHaveLength(1));
    expect(state.auth.loginBodies[0].remember).toBe(false);
  });

  it("o cadastro também oferece o checkbox, marcado, e envia o valor", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/register");
    const box = await screen.findByRole("checkbox", { name: "Manter conectado" });
    expect(box).toBeChecked();
    await user.click(box);
    await user.type(screen.getByLabelText("E-mail"), "nova@spook.dev");
    await user.type(screen.getByLabelText("Nome de usuário"), "nova");
    await user.type(screen.getByLabelText("Senha"), "senha-forte-123");
    await user.click(screen.getByRole("button", { name: "Criar conta" }));
    await waitFor(() => expect(state.auth.registerBodies).toHaveLength(1));
    expect(state.auth.registerBodies[0]).toMatchObject({
      email: "nova@spook.dev",
      remember: false,
    });
  });
});

describe("sessões ativas (Configurações > Perfil)", () => {
  const seed = (s: {
    auth: {
      sessions: {
        id: string;
        browser?: string;
        os?: string;
        remember: boolean;
        current: boolean;
        created_at: string;
        last_seen_at: string;
        expires_at: string;
      }[];
    };
  }) => {
    s.auth.sessions = [
      {
        id: "1",
        browser: "Chrome",
        os: "macOS",
        remember: true,
        current: true,
        created_at: iso(5 * 86_400_000),
        last_seen_at: iso(60_000),
        expires_at: iso(-80 * 86_400_000),
      },
      {
        id: "2",
        browser: "Firefox",
        os: "Windows",
        remember: false,
        current: false,
        created_at: iso(86_400_000),
        last_seen_at: iso(3 * 3_600_000),
        expires_at: iso(-20 * 3_600_000),
      },
      {
        id: "3",
        remember: true,
        current: false,
        created_at: iso(30 * 86_400_000),
        last_seen_at: iso(10 * 86_400_000),
        expires_at: iso(-50 * 86_400_000),
      },
    ];
  };

  it("lista dispositivo, 'Esta sessão' e o último uso; a atual não tem botão", async () => {
    await renderApp("/settings/profile", { signedIn: true, seed });
    const list = await screen.findByRole("list", { name: "Sessões ativas" });
    const items = within(list).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText("Chrome em macOS")).toBeInTheDocument();
    expect(within(items[0]).getByText("Esta sessão")).toBeInTheDocument();
    expect(within(items[0]).queryByRole("button")).not.toBeInTheDocument();
    expect(within(items[1]).getByText("Firefox em Windows")).toBeInTheDocument();
    expect(within(items[1]).getByText(/Sessão curta/)).toBeInTheDocument();
    expect(within(items[2]).getByText("Dispositivo desconhecido")).toBeInTheDocument();
    expect(within(items[2]).getByText(/Mantida conectada/)).toBeInTheDocument();
  });

  it("encerrar pede a senha (403), repete a ação e atualiza a lista", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/profile", { signedIn: true, seed });
    await user.click(
      await screen.findByRole("button", { name: "Encerrar a sessão de Firefox em Windows" }),
    );
    const dialog = await screen.findByRole("dialog", { name: "Confirme sua senha" });
    await user.type(within(dialog).getByLabelText("Senha"), "senha-correta-1");
    await user.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await waitFor(() => expect(state.auth.sessionRevokes).toEqual(["2"]));
    await waitFor(() => expect(screen.queryByText("Firefox em Windows")).not.toBeInTheDocument());
  });

  it("'Encerrar todas as outras' deixa só a atual", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/profile", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.account.confirmed = true;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Encerrar todas as outras" }));
    await waitFor(() => expect(state.auth.revokeOthers).toBe(1));
    await waitFor(() =>
      expect(
        screen.queryByRole("button", { name: "Encerrar todas as outras" }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText("Chrome em macOS")).toBeInTheDocument();
  });
});
