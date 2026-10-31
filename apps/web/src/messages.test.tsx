import { Permission } from "@spook/shared";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { guild, ME, member, messages } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;

function seed(opts: { count?: number; permissions?: number; authorId?: string } = {}) {
  return (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { permissions: opts.permissions ?? BASE }));
    s.members.g1 = [member(ME, "ana"), member("50", "bia")];
    s.messages[CH] = messages(CH, opts.count ?? 3, 1000, opts.authorId);
  };
}

const log = () => screen.findByRole("log", { name: "Mensagens de geral" });

describe("histórico", () => {
  it("mostra a última página, ancorada no fim, com o início do canal quando acaba", async () => {
    await renderApp(path, { signedIn: true, seed: seed({ count: 3 }) });
    const list = await log();
    expect(await within(list).findByText("mensagem 1002")).toBeInTheDocument();
    expect(within(list).getByText("mensagem 1000")).toBeInTheDocument();
    expect(within(list).getByText(/Este é o início de #geral/)).toBeInTheDocument();
    // mesma autora em sequência: um só cabeçalho (agrupamento)
    expect(within(list).getAllByRole("article")).toHaveLength(3);
    expect(within(list).getAllByText("bia")).toHaveLength(1);
  });

  it("não renderiza fora da janela (virtualização)", async () => {
    await renderApp(path, { signedIn: true, seed: seed({ count: 200 }) });
    const list = await log();
    await within(list).findByText("mensagem 1199"); // a mais nova da primeira página (50 mensagens)
    const rendered = within(list).getAllByRole("article").length;
    expect(rendered).toBeGreaterThan(0);
    expect(rendered).toBeLessThan(50); // só a janela visível + overscan, não a página inteira
  });

  it("rolar até o topo carrega a página anterior (before = mais antiga) e preserva a posição", async () => {
    const { state } = await renderApp(path, { signedIn: true, seed: seed({ count: 120 }) });
    const list = await log();
    await within(list).findByText("mensagem 1119");
    // ancorada no fim: a rolagem começa no final da lista
    await waitFor(() => expect(list.scrollTop).toBeGreaterThan(0));
    // primeira página: 50 mensagens (1070..1119)
    const first = state.requests.filter((r) => r.path.endsWith(`/${CH}/messages`));
    expect(first).toHaveLength(1);
    expect(first[0]?.search).toContain("limit=50");
    expect(first[0]?.search).not.toContain("before");

    // usuário rola para o alto
    list.scrollTop = 0;
    fireEvent.scroll(list);
    await waitFor(() => {
      const reqs = state.requests.filter((r) => r.path.endsWith(`/${CH}/messages`));
      expect(reqs).toHaveLength(2);
      expect(reqs[1]?.search).toContain("before=1070");
    });
    // a página anterior entrou; o item que estava no topo (1070) continua à vista e a rolagem
    // foi compensada (não ficou colada em 0, o que "pularia" para o início da página nova)
    expect(await within(list).findByText("mensagem 1069")).toBeInTheDocument();
    expect(within(list).getByText("mensagem 1070")).toBeInTheDocument();
    expect(list.scrollTop).toBeGreaterThan(0);
  });
});

describe("envio", () => {
  it("Enter envia, Shift+Enter quebra linha, e o contador conta até 2.000", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    expect(screen.getByText("0/2000")).toBeInTheDocument();
    await user.type(box, "olá{Shift>}{Enter}{/Shift}mundo");
    expect(box).toHaveValue("olá\nmundo");
    expect(screen.getByText("9/2000")).toBeInTheDocument();
    expect(state.requests.some((r) => r.method === "POST")).toBe(false);
    await user.type(box, "{Enter}");
    const list = await log();
    expect(await within(list).findByText(/olá\s+mundo/)).toBeInTheDocument();
    expect(box).toHaveValue("");
    expect(state.requests.find((r) => r.method === "POST")?.body).toEqual({
      content: "olá\nmundo",
    });
  });

  it("recusa mensagem vazia ou maior que 2.000 caracteres", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    const send = screen.getByRole("button", { name: "Enviar mensagem" });
    expect(send).toBeDisabled();
    await user.type(box, "   ");
    expect(send).toBeDisabled();
    fireEvent.change(box, { target: { value: "a".repeat(2001) } });
    expect(screen.getByText("2001/2000")).toBeInTheDocument();
    expect(send).toBeDisabled();
  });

  it("429: mostra contagem regressiva, mantém o texto e libera depois do Retry-After", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    state.rateLimited = 1;
    state.retryAfter = 1;
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "rápido demais{Enter}");
    expect(await screen.findByText(/Aguarde 1 s/)).toBeInTheDocument();
    expect(box).toHaveValue("rápido demais");
    expect(screen.getByRole("button", { name: "Enviar mensagem" })).toBeDisabled();
    // Enter durante a espera não envia
    await user.type(box, "{Enter}");
    expect(state.requests.filter((r) => r.method === "POST")).toHaveLength(1);

    await waitFor(() => expect(screen.queryByText(/Aguarde/)).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    await user.type(box, "{Enter}");
    expect(await within(await log()).findByText("rápido demais")).toBeInTheDocument();
    expect(box).toHaveValue("");
  });

  it("sem SEND_MESSAGES não há composer", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: seed({ permissions: Permission.VIEW_CHANNEL }),
    });
    await log();
    expect(screen.queryByLabelText("Mensagem em #geral")).not.toBeInTheDocument();
    expect(screen.getByText(/não tem permissão para enviar/)).toBeInTheDocument();
  });
});

describe("editar e excluir", () => {
  it("edita a própria mensagem e marca como editada", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ authorId: ME, count: 1 }) });
    const list = await log();
    await within(list).findByText("mensagem 1000");
    await user.click(within(list).getByRole("button", { name: "Editar mensagem" }));
    const edit = within(list).getByRole("textbox", { name: "Editar mensagem" });
    await user.clear(edit);
    await user.type(edit, "corrigida{Enter}");
    expect(await within(list).findByText(/corrigida/)).toBeInTheDocument();
    expect(within(list).getByText("(editada)")).toBeInTheDocument();
  });

  it("Esc cancela a edição", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ authorId: ME, count: 1 }) });
    const list = await log();
    await user.click(await within(list).findByRole("button", { name: "Editar mensagem" }));
    await user.type(within(list).getByRole("textbox", { name: "Editar mensagem" }), "x{Escape}");
    expect(within(list).queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(list).getByText("mensagem 1000")).toBeInTheDocument();
  });

  it("exclui a própria mensagem depois de confirmar", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ authorId: ME, count: 2 }) });
    const list = await log();
    await within(list).findByText("mensagem 1001");
    const [first] = within(list).getAllByRole("button", { name: "Excluir mensagem" });
    await user.click(first as HTMLElement);
    await user.click(await screen.findByRole("button", { name: "Excluir" }));
    await waitFor(() => expect(within(list).queryByText("mensagem 1000")).not.toBeInTheDocument());
    expect(within(list).getByText("mensagem 1001")).toBeInTheDocument();
  });

  it("de outros: só com MANAGE_MESSAGES pode excluir, e ninguém edita", async () => {
    const { unmount } = await renderApp(path, { signedIn: true, seed: seed({ count: 1 }) });
    const list = await log();
    await within(list).findByText("mensagem 1000");
    expect(
      within(list).queryByRole("button", { name: "Excluir mensagem" }),
    ).not.toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: "Editar mensagem" })).not.toBeInTheDocument();
    unmount();

    await renderApp(path, {
      signedIn: true,
      seed: seed({ count: 1, permissions: BASE | Permission.MANAGE_MESSAGES }),
    });
    const list2 = await log();
    expect(
      await within(list2).findByRole("button", { name: "Excluir mensagem" }),
    ).toBeInTheDocument();
    expect(
      within(list2).queryByRole("button", { name: "Editar mensagem" }),
    ).not.toBeInTheDocument();
  });
});
