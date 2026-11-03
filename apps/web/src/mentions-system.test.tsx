import { Permission } from "@spook/shared";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ThemeProvider } from "@/components/theme-provider";
import { shouldNotify } from "@/features/notifications/in-app";
import { bulkMentionsMe, EVERYONE_OPTIONS, filterMentionOptions } from "@/lib/mentions";
import { channel, guild, ME, member, messages } from "@/test/fixtures";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";
import { bulkOf, highlightMentions } from "./features/messages/message-row";

const CH = "g1-txt";
const path = `/channels/g1/${CH}`;
const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const roles = [
  { id: "r1", name: "Equipe Azul", color: "#3b82f6" },
  { id: "r2", name: "Staff" },
];

function pills(nodes: ReturnType<typeof highlightMentions>) {
  const { container } = render(
    <ThemeProvider>
      <p>{nodes}</p>
    </ThemeProvider>,
  );
  return [...container.querySelectorAll("mark")].map((m) => [
    m.getAttribute("data-mention-pill"),
    m.textContent,
  ]);
}

describe("pílulas de menção em massa", () => {
  it("@everyone, @here e @cargo só viram pílula quando a mensagem os marcou", () => {
    const text = "oi @everyone, @here e @equipe azul! também @Staff.";
    const bulk = { everyone: true, here: true, roles: roles.slice(0, 1) };
    expect(pills(highlightMentions(text, "ana", undefined, bulk))).toEqual([
      ["everyone", "@everyone"],
      ["everyone", "@here"],
      ["role", "@equipe azul"],
    ]);
    // sem a marca do servidor (autor sem permissão), é texto comum
    expect(pills(highlightMentions(text, "ana"))).toEqual([]);
  });

  it("não confunde com e-mail nem prefixo de palavra e mantém as menções de usuário", () => {
    const bulk = { everyone: true, here: false, roles: roles.slice(1) };
    const out = pills(
      highlightMentions(
        "a@everyone.com @everyones @Staffer @bia @staff",
        "ana",
        new Set(["bia"]),
        bulk,
      ),
    );
    expect(out).toEqual([
      ["other", "@bia"],
      ["role", "@staff"],
    ]);
  });

  it("bulkOf lista só os cargos citados", () => {
    const m = { ...messages(CH, 1)[0], mention_roles: ["r2"], mention_here: true } as never;
    expect(bulkOf(m, { roles, myRoleIds: [], suppressEveryone: false })).toEqual({
      everyone: false,
      here: true,
      roles: [roles[1]],
    });
  });
});

describe("quem a menção em massa atinge", () => {
  const base = { author: { id: "50" }, mention_roles: [] as string[] };
  it("cargo meu vale sempre; @everyone/@here, a menos que eu suprima; o autor não conta", () => {
    const ctx = { myRoleIds: ["r1"], suppressEveryone: false };
    expect(bulkMentionsMe({ ...base, mention_roles: ["r1"] }, ME, ctx)).toBe(true);
    expect(bulkMentionsMe({ ...base, mention_roles: ["r2"] }, ME, ctx)).toBe(false);
    expect(bulkMentionsMe({ ...base, mention_everyone: true }, ME, ctx)).toBe(true);
    expect(
      bulkMentionsMe({ ...base, mention_here: true }, ME, { ...ctx, suppressEveryone: true }),
    ).toBe(false);
    expect(
      bulkMentionsMe({ ...base, mention_roles: ["r1"] }, ME, { ...ctx, suppressEveryone: true }),
    ).toBe(true);
    expect(bulkMentionsMe({ author: { id: ME }, mention_everyone: true }, ME, ctx)).toBe(false);
  });

  it("aviso in-app: nível 'só menções' avisa por menção em massa; 'nada' e silêncio não", () => {
    const args = {
      authorId: "50",
      myId: ME,
      isDm: false,
      mentionIds: [],
      bulkMention: true,
      viewing: "away" as const,
      muted: false,
    };
    expect(shouldNotify({ ...args, level: "mentions" })).toBe(true);
    expect(shouldNotify({ ...args, level: "none" })).toBe(false);
    expect(shouldNotify({ ...args, level: "mentions", muted: true })).toBe(false);
    expect(shouldNotify({ ...args, level: "mentions", dnd: true })).toBe(false);
    expect(shouldNotify({ ...args, level: "mentions", bulkMention: false })).toBe(false);
  });

  it("autocomplete encontra @everyone e @here", () => {
    expect(filterMentionOptions(EVERYONE_OPTIONS, "ev").map((o) => o.handle)).toEqual(["everyone"]);
  });
});

function seed(opts: { permissions?: number; withRole?: boolean } = {}) {
  return (s: Backend["state"]) => {
    const g = guild("g1", "Alfa", {
      permissions: opts.permissions ?? BASE,
      my_role_ids: ["r1"],
    });
    g.roles = [
      ...(g.roles ?? []),
      {
        id: "r1",
        guild_id: "g1",
        name: "Equipe Azul",
        color: 0x3b82f6,
        position: 1,
        permissions: 0,
        is_everyone: false,
        mentionable: !!opts.withRole,
      },
      {
        id: "r2",
        guild_id: "g1",
        name: "Diretoria",
        color: null,
        position: 2,
        permissions: 0,
        is_everyone: false,
        mentionable: false,
      },
    ];
    g.channels = [{ ...channel(CH, "geral", 0), topic: "Avisos e regras do servidor" }];
    s.guilds.push(g);
    s.members.g1 = [member(ME, "ana"), member("50", "bia")];
    const [m1, m2] = messages(CH, 2, 1000);
    s.messages[CH] = [
      { ...(m1 as object), content: "reunião @everyone às 10", mention_everyone: true },
      {
        ...(m2 as object),
        id: "1002",
        content: "",
        kind: "member_join",
        author: { id: "60", username: "carla" },
      },
    ] as never;
  };
}

describe("tela do canal", () => {
  it("mensagem de sistema vira linha centralizada e a menção em massa destaca a linha", async () => {
    await renderApp(path, { signedIn: true, seed: seed() });
    const list = await screen.findByRole("log", { name: "Mensagens de geral" });
    const join = await within(list).findByLabelText("carla entrou no servidor");
    expect(join).toHaveAttribute("data-system", "member_join");
    expect(within(list).queryByRole("button", { name: "Responder" })).toBeInTheDocument(); // a outra mensagem segue normal
    expect(join.querySelector("button")).toBeNull(); // sem ações na linha de sistema
    const row = (await within(list).findByText(/reunião/)).closest("article") as HTMLElement;
    expect(row).toHaveAttribute("data-mention", "true");
    expect(within(row).getByText("@everyone")).toHaveAttribute("data-mention-pill", "everyone");
  });

  it("tópico no cabeçalho: truncado, abre inteiro no clique", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed() });
    const topic = await screen.findByTestId("channel-topic");
    expect(topic).toHaveTextContent("Avisos e regras do servidor");
    expect(topic.className).toContain("truncate");
    await user.click(topic);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Avisos e regras do servidor")).toBeInTheDocument();
  });

  it("autocomplete: sem MENTION_EVERYONE só aparecem cargos mencionáveis", async () => {
    const user = userEvent.setup();
    await renderApp(path, { signedIn: true, seed: seed({ withRole: true }) });
    await user.type(await screen.findByLabelText("Mensagem em #geral"), "@");
    const box = await screen.findByRole("listbox", { name: "Sugestões de menção" });
    expect(within(box).getByText("Equipe Azul")).toBeInTheDocument();
    expect(within(box).queryByText("Diretoria")).toBeNull();
    expect(within(box).queryByText("@everyone")).toBeNull();
  });

  it("autocomplete: com MENTION_EVERYONE aparecem @everyone, @here e todos os cargos", async () => {
    const user = userEvent.setup();
    await renderApp(path, {
      signedIn: true,
      seed: seed({ permissions: BASE | Permission.MENTION_EVERYONE }),
    });
    await user.type(await screen.findByLabelText("Mensagem em #geral"), "@");
    const box = await screen.findByRole("listbox", { name: "Sugestões de menção" });
    for (const t of ["@everyone", "@here", "Equipe Azul", "Diretoria"])
      expect(within(box).getByText(t)).toBeInTheDocument();
  });
});

describe("excluir servidor", () => {
  it("exige digitar o nome e confirmar a senha antes de apagar", async () => {
    const user = userEvent.setup();
    const { state } = await renderApp("/channels/g1", {
      signedIn: true,
      seed: (s) => {
        s.guilds.push(guild("g1", "Alfa", { is_owner: true, permissions: 1 << 20, owner_id: ME }));
        s.members.g1 = [member(ME, "ana")];
      },
    });
    await user.click(await screen.findByRole("button", { name: /Menu do servidor/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Configurações do servidor/ }));
    await user.click(await screen.findByRole("button", { name: "Excluir servidor" }));
    const confirm = await screen.findByRole("button", { name: "Excluir servidor", hidden: false });
    const buttons = screen.getAllByRole("button", { name: "Excluir servidor" });
    const action = buttons[buttons.length - 1] as HTMLElement;
    expect(action).toBeDisabled();
    expect(confirm).toBeTruthy();
    await user.type(screen.getByLabelText(/Digite o nome do servidor/), "Alfa");
    expect(action).toBeEnabled();
    await user.click(action);
    // o servidor pede a senha: o diálogo "Confirme sua senha" abre e a ação é repetida
    await user.type(await screen.findByLabelText(/Senha/), "senha-correta-1");
    await user.click(screen.getByRole("button", { name: /Confirmar/ }));
    await waitFor(() =>
      expect(state.requests.some((r) => r.method === "DELETE" && r.path === "/api/guilds/g1")).toBe(
        true,
      ),
    );
  });
});
