import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { guild, ME, member } from "@/test/fixtures";
import { renderApp } from "@/test/render";

describe("convites", () => {
  it("sem sessão, pede login e volta ao convite depois", async () => {
    const user = userEvent.setup();
    const { router } = await renderApp("/invite/abcd2345", {
      seed: (s) => {
        s.invites.abcd2345 = { guild: guild("g9", "Clube") };
      },
    });
    expect(await screen.findByRole("heading", { name: "Entrar" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/login");
    expect(router.state.location.search).toEqual({ redirect: "/invite/abcd2345" });

    await user.type(screen.getByLabelText("E-mail"), "ana@spook.dev");
    await user.type(screen.getByLabelText("Senha"), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: "Entrar" }));
    expect(await screen.findByText("Clube")).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/invite/abcd2345");
  });

  it("pré-visualiza e entra no servidor", async () => {
    const user = userEvent.setup();
    const { router, state } = await renderApp("/invite/abcd2345", {
      signedIn: true,
      seed: (s) => {
        s.invites.abcd2345 = { guild: guild("g9", "Clube") };
        s.members.g9 = [member(ME, "ana")];
      },
    });
    expect(await screen.findByText("Clube")).toBeInTheDocument();
    expect(screen.getByText(/3 membros/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Entrar no servidor" }));
    expect(await screen.findByRole("heading", { name: "geral" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/channels/g9/g9-txt");
    expect(state.guilds.map((g) => g.id)).toEqual(["g9"]);
    expect(screen.getByRole("link", { name: "Clube" })).toBeInTheDocument();
  });

  it("convite expirado (410) avisa e não oferece entrar", async () => {
    await renderApp("/invite/velho123", {
      signedIn: true,
      seed: (s) => {
        s.invites.velho123 = { guild: guild("g9", "Clube"), gone: true };
      },
    });
    expect(await screen.findByText("Convite expirado")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("expirou");
    expect(screen.queryByRole("button", { name: "Entrar no servidor" })).not.toBeInTheDocument();
  });

  it("convite inexistente (404)", async () => {
    await renderApp("/invite/naoexiste", { signedIn: true });
    expect(await screen.findByText("Convite indisponível")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("não existe");
  });

  it("convite que expira entre a prévia e o clique mostra o erro em toast", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/invite/abcd2345", {
      signedIn: true,
      seed: (s) => {
        s.invites.abcd2345 = { guild: guild("g9", "Clube") };
      },
    });
    await screen.findByText("Clube");
    const inv = state.invites.abcd2345;
    if (inv) inv.gone = true;
    await user.click(screen.getByRole("button", { name: "Entrar no servidor" }));
    expect(await screen.findByText(/expirou ou atingiu o limite/)).toBeInTheDocument();
  });
});
