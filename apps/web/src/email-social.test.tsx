import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";

const navigated = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock("@/lib/navigate", () => ({
  navigateTo: (url: string) => {
    navigated.urls.push(url);
  },
}));

beforeEach(() => {
  navigated.urls = [];
  sessionStorage.clear();
  localStorage.clear();
});

const TOKEN = "tok_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF";
const CORRECT = "senha-correta-1";

describe("login: esqueci a senha e login social", () => {
  it("mostra o link de recuperação e os botões só dos provedores ligados", async () => {
    await renderApp("/login", {
      seed: (s) => {
        s.auth.providers = ["google", "discord"];
      },
    });
    expect(await screen.findByRole("link", { name: "Esqueci minha senha" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
    const google = await screen.findByRole("link", { name: /Continuar com Google/ });
    expect(google).toHaveAttribute("href", "/api/auth/social/google/start");
    expect(screen.getByRole("link", { name: /Continuar com Discord/ })).toBeInTheDocument();
  });

  it("não mostra botões quando nenhum provedor está ligado", async () => {
    await renderApp("/login");
    await screen.findByRole("button", { name: "Entrar" });
    expect(screen.queryByText(/Continuar com/)).not.toBeInTheDocument();
  });

  it("repassa o destino (redirect) ao início do fluxo e mostra os erros do retorno", async () => {
    await renderApp("/login?redirect=/invite/abc12345&social_error=email_unverified", {
      seed: (s) => {
        s.auth.providers = ["google"];
      },
    });
    expect(await screen.findByRole("link", { name: /Continuar com Google/ })).toHaveAttribute(
      "href",
      "/api/auth/social/google/start?redirect=%2Finvite%2Fabc12345",
    );
    expect(
      screen.getByText(/O e-mail da sua conta no provedor não está verificado/),
    ).toBeInTheDocument();
  });

  it("o cadastro também oferece o login social", async () => {
    await renderApp("/register", {
      seed: (s) => {
        s.auth.providers = ["discord"];
      },
    });
    expect(await screen.findByRole("link", { name: /Continuar com Discord/ })).toHaveAttribute(
      "href",
      "/api/auth/social/discord/start",
    );
  });

  it("ignora códigos de erro desconhecidos com uma mensagem genérica", async () => {
    await renderApp("/login?social_error=algo_novo");
    expect(
      await screen.findByText("Não foi possível concluir o login com o provedor."),
    ).toBeInTheDocument();
  });
});

describe("esqueci minha senha", () => {
  it("valida o e-mail no cliente e confirma sem revelar se a conta existe", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/forgot-password");
    await user.type(await screen.findByLabelText("E-mail"), "invalido");
    await user.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(await screen.findByText("E-mail inválido.")).toBeInTheDocument();
    expect(state.auth.forgots).toHaveLength(0);

    await user.clear(screen.getByLabelText("E-mail"));
    await user.type(screen.getByLabelText("E-mail"), "qualquer@spook.dev");
    await user.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(await screen.findByText("Confira seu e-mail")).toBeInTheDocument();
    expect(screen.getByText(/Se existir uma conta com qualquer@spook.dev/)).toBeInTheDocument();
    expect(state.auth.forgots).toEqual(["qualquer@spook.dev"]);
  });

  it("avisa quando o servidor não envia e-mails (modo degradado)", async () => {
    await renderApp("/forgot-password");
    expect(
      await screen.findByText(/Este servidor não envia e-mails\. Peça ao administrador/),
    ).toBeInTheDocument();
  });

  it("não mostra o aviso de degradado quando o e-mail está ligado", async () => {
    await renderApp("/forgot-password", {
      seed: (s) => {
        s.auth.emailEnabled = true;
      },
    });
    await screen.findByRole("button", { name: "Enviar link" });
    await waitFor(() =>
      expect(screen.queryByText(/Este servidor não envia/)).not.toBeInTheDocument(),
    );
  });

  it("mostra o limite de tentativas", async () => {
    const user = userEvent.setup();
    await renderApp("/forgot-password", {
      seed: (s) => {
        s.auth.forgotStatus = 429;
      },
    });
    await user.type(await screen.findByLabelText("E-mail"), "a@spook.dev");
    await user.click(screen.getByRole("button", { name: "Enviar link" }));
    expect(await screen.findByText(/Muitas tentativas/)).toBeInTheDocument();
  });
});

describe("redefinir senha", () => {
  it("sem token mostra o link inválido", async () => {
    await renderApp("/reset-password");
    expect(await screen.findByText("Link inválido")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir novo link" })).toHaveAttribute(
      "href",
      "/forgot-password",
    );
  });

  it("valida, redefine e retira o token da URL", async () => {
    const user = userEvent.setup();
    const { state, router } = await renderApp(`/reset-password?token=${TOKEN}`, {
      seed: (s) => {
        s.auth.tokens[TOKEN] = "verified";
      },
    });
    await user.type(await screen.findByLabelText("Nova senha"), "curta");
    await user.type(screen.getByLabelText("Repita a nova senha"), "diferente");
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(
      await screen.findByText("A senha precisa ter ao menos 8 caracteres."),
    ).toBeInTheDocument();
    expect(screen.getByText("As senhas não coincidem.")).toBeInTheDocument();
    expect(state.auth.resets).toHaveLength(0);

    await user.clear(screen.getByLabelText("Nova senha"));
    await user.clear(screen.getByLabelText("Repita a nova senha"));
    await user.type(screen.getByLabelText("Nova senha"), "nova-senha-123");
    await user.type(screen.getByLabelText("Repita a nova senha"), "nova-senha-123");
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(await screen.findByText("Senha redefinida")).toBeInTheDocument();
    expect(state.auth.resets).toEqual([{ token: TOKEN, new_password: "nova-senha-123" }]);
    // o token não fica na URL
    expect(router.state.location.search).toEqual({});
    expect(screen.getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/login");
  });

  it.each([
    ["expired", "Link expirado"],
    ["invalid", "Link inválido"],
  ] as const)("token %s", async (kind, title) => {
    const user = userEvent.setup();
    await renderApp(`/reset-password?token=${TOKEN}`, {
      seed: (s) => {
        s.auth.tokens[TOKEN] = kind;
      },
    });
    await user.type(await screen.findByLabelText("Nova senha"), "nova-senha-123");
    await user.type(screen.getByLabelText("Repita a nova senha"), "nova-senha-123");
    await user.click(screen.getByRole("button", { name: "Redefinir senha" }));
    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Pedir novo link" })).toBeInTheDocument();
  });
});

describe("verificar e-mail", () => {
  it("confirma o endereço e retira o token da URL", async () => {
    const { state, router } = await renderApp(`/verify-email?token=${TOKEN}`, {
      seed: (s) => {
        s.auth.tokens[TOKEN] = "verified";
      },
    });
    expect(await screen.findByText("E-mail confirmado")).toBeInTheDocument();
    expect(state.auth.verifies).toEqual([TOKEN]);
    expect(router.state.location.search).toEqual({});
    expect(screen.getByRole("link", { name: "Abrir o Spook" })).toBeInTheDocument();
  });

  it("conclui a troca de e-mail", async () => {
    await renderApp(`/verify-email?token=${TOKEN}`, {
      seed: (s) => {
        s.auth.tokens[TOKEN] = "changed";
      },
    });
    expect(await screen.findByText("E-mail alterado")).toBeInTheDocument();
  });

  it("link expirado: quem está logado pode reenviar", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(`/verify-email?token=${TOKEN}`, {
      signedIn: true,
      seed: (s) => {
        s.auth.tokens[TOKEN] = "expired";
      },
    });
    expect(await screen.findByText("Link expirado")).toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Reenviar e-mail" }));
    await waitFor(() => expect(state.auth.resends).toBe(1));
    expect(await screen.findByText("Enviamos um novo link para o seu e-mail.")).toBeInTheDocument();
  });

  it("link inválido sem sessão leva ao login", async () => {
    await renderApp(`/verify-email?token=${TOKEN}`);
    expect(await screen.findByText("Link inválido")).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Entrar para reenviar" })).toBeInTheDocument();
  });

  it("sem token é inválido", async () => {
    await renderApp("/verify-email");
    expect(await screen.findByText("Link inválido")).toBeInTheDocument();
  });
});

describe("faixa de verificação de e-mail", () => {
  const unverified = (s: {
    user: { email_verified?: boolean };
    auth: { emailEnabled: boolean };
  }) => {
    s.user.email_verified = false;
    s.auth.emailEnabled = true;
  };

  it("aparece para conta não verificada, reenvia e pode ser dispensada", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/", { signedIn: true, seed: unverified });
    const banner = await screen.findByRole("status");
    expect(within(banner).getByText("Verifique seu e-mail.")).toBeInTheDocument();
    await user.click(within(banner).getByRole("button", { name: "Reenviar" }));
    await waitFor(() => expect(state.auth.resends).toBe(1));
    await user.click(within(banner).getByRole("button", { name: "Dispensar aviso" }));
    await waitFor(() =>
      expect(screen.queryByText("Verifique seu e-mail.")).not.toBeInTheDocument(),
    );
    expect(sessionStorage.getItem("spook:verify-banner-dismissed")).toBe("1");
  });

  it("não aparece com o e-mail verificado nem em modo degradado", async () => {
    await renderApp("/", { signedIn: true });
    await screen.findByRole("link", { name: /Início|Mensagens diretas/i }).catch(() => null);
    expect(screen.queryByText("Verifique seu e-mail.")).not.toBeInTheDocument();
  });

  it("modo degradado (servidor sem e-mail) não incomoda", async () => {
    await renderApp("/", {
      signedIn: true,
      seed: (s) => {
        s.user.email_verified = false;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByText("Verifique seu e-mail.")).not.toBeInTheDocument();
  });
});

describe("escolha seu username (cadastro social)", () => {
  const pending = {
    provider: "google",
    email: "maria@gmail.com",
    suggested_username: "maria_silva",
  };

  it("vem com a sugestão, trata erros do servidor e conclui", async () => {
    const user = userEvent.setup();
    const { state, router } = await renderApp("/auth/choose-username", {
      seed: (s) => {
        s.auth.pending = pending;
      },
    });
    const input = await screen.findByLabelText("Nome de usuário");
    expect(screen.getByText(/Você entrou com o Google como maria@gmail.com/)).toBeInTheDocument();
    await waitFor(() => expect(input).toHaveValue("maria_silva"));

    await user.clear(input);
    await user.type(input, "Inválido!");
    await user.click(screen.getByRole("button", { name: "Concluir cadastro" }));
    expect(await screen.findByText(/Use de 2 a 32 caracteres/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "ocupado");
    await user.click(screen.getByRole("button", { name: "Concluir cadastro" }));
    expect(await screen.findByText("Nome de usuário já em uso")).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "admin");
    await user.click(screen.getByRole("button", { name: "Concluir cadastro" }));
    expect(await screen.findByText(/Esse nome não pode ser usado/)).toBeInTheDocument();

    await user.clear(input);
    await user.type(input, "maria");
    await user.click(screen.getByRole("button", { name: "Concluir cadastro" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
    expect(state.auth.completes).toEqual(["ocupado", "admin", "maria"]);
  });

  it("cadastro expirado volta ao login", async () => {
    await renderApp("/auth/choose-username");
    expect(await screen.findByText("Cadastro expirado")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Voltar para entrar" })).toHaveAttribute(
      "href",
      "/login",
    );
  });
});

describe("login do desktop pelo navegador", () => {
  const challenge = "A".repeat(43);

  it("sem sessão leva ao login e volta depois", async () => {
    const { router } = await renderApp(`/desktop-login?code_challenge=${challenge}`);
    await waitFor(() => expect(router.state.location.pathname).toBe("/login"));
    expect(router.state.location.search).toMatchObject({
      redirect: `/desktop-login?code_challenge=${challenge}`,
    });
  });

  it("desafio inválido", async () => {
    await renderApp("/desktop-login?code_challenge=curto", { signedIn: true });
    expect(await screen.findByText("Link inválido")).toBeInTheDocument();
  });

  it("confirma e abre o deep link", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(`/desktop-login?code_challenge=${challenge}`, {
      signedIn: true,
    });
    expect(await screen.findByText(/Você está conectado como @ana/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Entrar no app do computador" }));
    expect(await screen.findByText("Pronto! Volte ao app")).toBeInTheDocument();
    expect(state.auth.desktopChallenges).toEqual([challenge]);
    expect(navigated.urls).toEqual(["spook://auth?code=codigo-de-uso-unico-123456"]);
    expect(screen.getByRole("link", { name: "Abrir o app" })).toHaveAttribute(
      "href",
      "spook://auth?code=codigo-de-uso-unico-123456",
    );
  });
});

describe("configurações: e-mail e contas vinculadas", () => {
  it("mostra se o e-mail está verificado", async () => {
    await renderApp("/settings/profile", { signedIn: true });
    expect(await screen.findByTestId("email-status")).toHaveTextContent("E-mail verificado");
  });

  it("troca de e-mail com verificação: avisa que falta confirmar no endereço novo", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/profile", {
      signedIn: true,
      seed: (s) => {
        s.auth.emailChangePending = true;
        s.account.confirmed = true;
      },
    });
    const email = await screen.findByLabelText("E-mail");
    await user.clear(email);
    await user.type(email, "novo@spook.dev");
    await user.click(screen.getByRole("button", { name: "Trocar e-mail" }));
    await waitFor(() => expect(state.account.emailChanges).toEqual(["novo@spook.dev"]));
    expect(
      await screen.findByText(/Enviamos um link de confirmação para novo@spook.dev/),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Aguardando confirmação do novo endereço/)).toBeInTheDocument();
  });

  it("lista as contas vinculadas e desvincula com a senha confirmada", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/profile", {
      signedIn: true,
      seed: (s) => {
        s.auth.providers = ["google", "discord"];
        s.auth.methods = {
          has_password: true,
          accounts: [
            { provider: "google", email: "ana@gmail.com", created_at: "2026-11-01T00:00:00Z" },
          ],
        };
        s.account.confirmed = true;
      },
    });
    expect(await screen.findByText("Vinculado (ana@gmail.com)")).toBeInTheDocument();
    expect(screen.getByText("Não vinculado")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Desvincular Google" }));
    await waitFor(() => expect(state.auth.unlinks).toEqual(["google"]));
    expect(await screen.findByText("Google desvinculado.")).toBeInTheDocument();
  });

  it("vincular pede a senha e depois inicia o fluxo no provedor", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/profile", {
      signedIn: true,
      seed: (s) => {
        s.auth.providers = ["discord"];
      },
    });
    await user.click(await screen.findByRole("button", { name: "Vincular Discord" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText("Senha"), CORRECT);
    await user.click(within(dialog).getByRole("button", { name: "Confirmar" }));
    await waitFor(() =>
      expect(navigated.urls).toEqual([
        "/api/auth/social/discord/start?intent=link&redirect=%2Fsettings%2Fprofile",
      ]),
    );
  });

  it("não deixa desvincular o último método de login", async () => {
    const user = userEvent.setup();
    await renderApp("/settings/profile", {
      signedIn: true,
      seed: (s) => {
        s.user.has_password = false;
        s.auth.providers = ["google"];
        s.auth.methods = {
          has_password: false,
          accounts: [{ provider: "google", created_at: "2026-11-01T00:00:00Z" }],
        };
        s.auth.unlinkStatus = 409;
      },
    });
    await user.click(await screen.findByRole("button", { name: "Desvincular Google" }));
    expect(await screen.findByText(/único método de login/)).toBeInTheDocument();
  });

  it("conta sem senha: define a primeira senha depois de reautenticar com o provedor", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/settings/profile", {
      signedIn: true,
      seed: (s) => {
        s.user.has_password = false;
        s.auth.providers = ["google"];
        s.auth.methods = {
          has_password: false,
          accounts: [{ provider: "google", created_at: "2026-11-01T00:00:00Z" }],
        };
        s.auth.initialPasswordStatus = 403;
      },
    });
    expect(screen.queryByLabelText("Senha atual")).not.toBeInTheDocument();
    await user.type(await screen.findByLabelText("Nova senha"), "primeira-senha-1");
    await user.type(screen.getByLabelText("Repita a senha"), "primeira-senha-1");
    await user.click(screen.getByRole("button", { name: "Definir senha" }));
    const reauth = await screen.findByRole("link", { name: "Confirmar com Google" });
    expect(reauth).toHaveAttribute(
      "href",
      "/api/auth/social/google/start?intent=reauth&redirect=%2Fsettings%2Fprofile",
    );
    state.auth.initialPasswordStatus = 204;
    await user.click(screen.getByRole("button", { name: "Definir senha" }));
    await waitFor(() => expect(state.auth.initialPasswords).toEqual(["primeira-senha-1"]));
    expect(await screen.findByText(/Senha definida/)).toBeInTheDocument();
  });

  it("mostra o resultado do retorno do provedor (?linked=)", async () => {
    await renderApp("/settings/profile?linked=google", {
      signedIn: true,
      seed: (s) => {
        s.auth.providers = ["google"];
      },
    });
    expect(await screen.findByText("Google vinculado à sua conta.")).toBeInTheDocument();
  });
});
