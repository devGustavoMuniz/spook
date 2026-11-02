import { Permission } from "@spook/shared";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { guild, ME, member, messages } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import { type Backend, server } from "@/test/server";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const log = () => screen.findByRole("log", { name: "Mensagens de geral" });
const link = (code: string) => `${window.location.origin}/invite/${code}`;

function seed(extra: (s: Backend["state"]) => void = () => {}) {
  return (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { permissions: BASE }));
    s.members.g1 = [
      member(ME, "ana"),
      { ...member("50", "bia"), display_name: "Beatriz Lima" },
      member("51", "bruno"),
      member("52", "carla"),
    ];
    s.messages[CH] = messages(CH, 1);
    extra(s);
  };
}

describe("autocompletar de menção @", () => {
  it("sugere membros ao digitar @, filtra por username e nome de exibição e insere @username", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "oi @b");
    const list = await screen.findByRole("listbox", { name: "Sugestões de menção" });
    const options = within(list).getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual([
      expect.stringContaining("Beatriz Lima"),
      expect.stringContaining("bruno"),
    ]);
    // semântica de combobox enquanto aberta
    expect(box).toHaveAttribute("role", "combobox");
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box).toHaveAttribute("aria-controls", list.id);
    expect(box.getAttribute("aria-activedescendant")).toBe(options[0]?.id);
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowDown}"); // dá a volta
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{ArrowUp}");
    expect(options[1]).toHaveAttribute("aria-selected", "true");
    await user.keyboard("{Enter}");
    expect(box).toHaveValue("oi @bruno ");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box).not.toHaveAttribute("role", "combobox");
  });

  it("Enter escolhe a sugestão e NÃO envia a mensagem", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "@car{Enter}");
    expect(box).toHaveValue("@carla ");
    expect(state.requests.some((r) => r.method === "POST")).toBe(false);
  });

  it("Tab também escolhe; filtra pelo nome de exibição", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "@lima{Tab}");
    expect(box).toHaveValue("@bia ");
  });

  it("Esc fecha a lista sem apagar o texto, e @ novo reabre", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "@b");
    await screen.findByRole("listbox");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(box).toHaveValue("@b");
    await user.type(box, " e @c");
    expect(await screen.findByRole("option", { name: /carla/ })).toBeInTheDocument();
  });

  it("clicar numa sugestão insere a menção; Enter sem lista aberta envia normalmente", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "@br");
    await user.click(await screen.findByRole("option", { name: /bruno/ }));
    expect(box).toHaveValue("@bruno ");
    await user.type(box, "oi{Enter}");
    await waitFor(() =>
      expect(state.requests.find((r) => r.method === "POST")?.body).toMatchObject({
        content: "@bruno oi",
      }),
    );
  });

  it("não sugere para e-mail nem para quem não existe, e não sugere a mim mesmo", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.type(box, "fala a@b");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "@zzz");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "@an");
    expect(screen.queryByRole("option", { name: /ana/ })).not.toBeInTheDocument();
  });

  it("em DM sugere os participantes da conversa", async () => {
    const user = userEvent.setup();
    const { dm, recipient } = await import("@/test/fixtures");
    await renderApp("/channels/@me/d1", {
      signedIn: true,
      seed: (s) => {
        s.dms.push(dm("d1", [recipient("60", "caio", "Caio Prado")]));
        s.messages.d1 = messages("d1", 1, 1000, "60");
      },
    });
    const box = await screen.findByLabelText(/Mensagem para/);
    await user.type(box, "@ca");
    expect(await screen.findByRole("option", { name: /Caio Prado/ })).toBeInTheDocument();
  });
});

describe("cartão de convite", () => {
  const withInvites = (list: string[]) =>
    seed((s) => {
      s.messages[CH] = [
        {
          ...messages(CH, 1)[0],
          id: "2000",
          content: `entra aí ${list.map(link).join(" ")}`,
        } as never,
      ];
      s.invites.abcd2345 = { guild: guild("g9", "Clube") };
      s.invites.velho123 = { guild: guild("g8", "Antigo"), gone: true };
    });

  it("renderiza o cartão do servidor e entra pelo botão", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp(path, { signedIn: true, seed: withInvites(["abcd2345"]) });
    const list = await log();
    expect(await within(list).findByText("Clube")).toBeInTheDocument();
    expect(within(list).getByText(/3 membros/)).toBeInTheDocument();
    await user.click(within(list).getByRole("button", { name: "Entrar em Clube" }));
    await waitFor(() => expect(state.guilds.map((g) => g.id)).toContain("g9"));
  });

  it("se já sou membro oferece 'Abrir servidor'", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: (s) => {
        withInvites(["abcd2345"])(s);
        s.guilds.push(guild("g9", "Clube", { permissions: BASE }));
      },
    });
    const list = await log();
    expect(await within(list).findByRole("link", { name: /Abrir servidor/ })).toHaveAttribute(
      "href",
      "/channels/g9",
    );
    expect(within(list).queryByRole("button", { name: /Entrar em/ })).not.toBeInTheDocument();
  });

  it("convite expirado e convite inexistente mostram estados próprios, sem botão de entrar", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: withInvites(["velho123", "naoexiste"]),
    });
    const list = await log();
    expect(await within(list).findByText("Convite expirado")).toBeInTheDocument();
    expect(await within(list).findByText("Convite inválido")).toBeInTheDocument();
    expect(within(list).queryByRole("button", { name: /Entrar em/ })).not.toBeInTheDocument();
  });

  it("o mesmo código em várias mensagens pede o convite uma vez só (cache)", async () => {
    const hits: string[] = [];
    server.events.on("request:start", ({ request }) => {
      if (new URL(request.url).pathname.endsWith("/invites/abcd2345")) hits.push(request.method);
    });
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        s.messages[CH] = [1, 2, 3].map(
          (i) =>
            ({
              ...messages(CH, 1)[0],
              id: String(3000 + i),
              content: `de novo ${link("abcd2345")}`,
            }) as never,
        );
        s.invites.abcd2345 = { guild: guild("g9", "Clube") };
      }),
    });
    const list = await log();
    await waitFor(() => expect(within(list).getAllByText("Clube")).toHaveLength(3));
    expect(hits).toEqual(["GET"]);
    server.events.removeAllListeners();
  });

  it("link de outro domínio não vira cartão", async () => {
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        s.messages[CH] = [
          {
            ...messages(CH, 1)[0],
            id: "4000",
            content: "https://outro.com/invite/abcd2345",
          } as never,
        ];
        s.invites.abcd2345 = { guild: guild("g9", "Clube") };
      }),
    });
    const list = await log();
    await within(list).findByText(/outro.com/);
    expect(within(list).queryByText("Clube")).not.toBeInTheDocument();
  });

  it("ao colar um link no composer mostra a prévia do servidor (sem ação)", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: withInvites([]) });
    const box = await screen.findByLabelText("Mensagem em #geral");
    await user.click(box);
    await user.paste(link("abcd2345"));
    expect(await screen.findByText("Clube")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Entrar em Clube" })).not.toBeInTheDocument();
  });
});

describe("(editada)", () => {
  it("aparece em mensagem editada, com a data completa no tooltip", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: seed((s) => {
        s.messages[CH] = [
          {
            ...messages(CH, 1)[0],
            id: "5000",
            content: "texto novo",
            edited_at: "2026-10-30T13:30:00Z",
          } as never,
        ];
      }),
    });
    const list = await log();
    const tag = await within(list).findByText("(editada)");
    await user.hover(tag);
    expect((await screen.findAllByText(/Editada em/)).length).toBeGreaterThan(0);
    expect(within(list).queryByText(/mensagem 1000/)).not.toBeInTheDocument();
  });

  it("mensagem nunca editada não tem o marcador", async () => {
    await renderApp(path, { signedIn: true, seed: seed() });
    const list = await log();
    await within(list).findByText("mensagem 1000");
    expect(within(list).queryByText("(editada)")).not.toBeInTheDocument();
  });
});
