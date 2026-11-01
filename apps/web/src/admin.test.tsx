import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";

const day = (i: number) => `2026-10-${String(18 + i).padStart(2, "0")}`;
const series = (f: (i: number) => number) =>
  Array.from({ length: 14 }, (_, i) => ({ date: day(i), count: f(i) }));

const overview = {
  generated_at: "2026-10-31T15:30:00Z",
  users: { total: 120, new_24h: 3, new_7d: 12, growth_pct: 11.1 },
  accounts: { registered: 120, admins: 2, with_avatar: 40 },
  servers: {
    total: 9,
    memberships: 55,
    text_channels: 20,
    voice_channels: 8,
    categories: 9,
    roles: 14,
    active_invites: 4,
    invite_uses: 31,
    with_icon: 3,
  },
  messages: { total: 5000, last_24h: 210, last_7d: 1300, in_guilds: 4200, in_dms: 800 },
  attachments: { count: 7, bytes: 3_145_728 },
  conversations: { direct: 15, groups: 2 },
  new_users_per_day: series((i) => (i === 13 ? 4 : i % 3)),
  messages_per_day: series((i) => i * 10),
  new_users_trend: { recent: 6, previous: 4, change_pct: 50 },
  messages_trend: { recent: 450, previous: 150, change_pct: 200 },
};

const live = {
  generated_at: "2026-10-31T15:30:00Z",
  calls: { available: true, ongoing: 2, people: 5, cameras: 1, screens: 1 },
  livekit: {
    available: false,
    reason: "o Prometheus do LiveKit não está configurado",
    rooms: 0,
    participants: 0,
    tracks_published: 0,
    tracks_subscribed: 0,
    bytes_in: 0,
    bytes_out: 0,
    bytes_in_per_sec: 0,
    bytes_out_per_sec: 0,
    packets_in: 0,
    packets_out: 0,
    packets_per_sec: 0,
    packet_loss_pct: null,
    jitter_ms: null,
    rtt_ms: null,
    quality_score: null,
  },
};

const system = {
  generated_at: "2026-10-31T15:30:00Z",
  app: {
    version: "ghcr.io/x/spook:abc123",
    commit: "abc123",
    environment: "production",
    server_time: "2026-10-31T15:30:00Z",
    started_at: "2026-10-30T15:30:00Z",
    uptime_seconds: 90_000,
    go_version: "go1.26.0",
    goroutines: 42,
    heap_bytes: 10_485_760,
    sys_bytes: 30_000_000,
    rss_bytes: null,
  },
  database: {
    size_bytes: 20_971_520,
    tables: [{ name: "messages", bytes: 8_388_608, rows_estimate: 5000 }],
    pool: { max: 10, open: 3, idle: 2, in_use: 1, wait_count: 0 },
  },
  storage: { attachment_count: 7, attachment_bytes: 3_145_728, avatars: 40, guild_icons: 3 },
  jobs: { available: true, pending: 1, running: 0, retryable: 0, failed: 2, scheduled: 0 },
  gateway: {
    available: true,
    connections: 6,
    sessions: 7,
    online_users: 5,
    events_per_second: 12.5,
    events_total: 9000,
  },
};

const userRow = (n: number) => ({
  id: String(n),
  username: `user${n}`,
  email: `user${n}@x.dev`,
  guilds_member: n,
  guilds_owned: 0,
  messages_sent: n * 2,
  last_active_at: "2026-10-31T10:00:00Z",
  created_at: "2026-10-01T10:00:00Z",
});

type Hit = { path: string; search: URLSearchParams };

/** Registra as rotas /api/admin/* e guarda cada requisição (para checar sort, busca e polling). */
function adminApi(over: { overview?: unknown; live?: unknown; calls?: unknown } = {}) {
  const hits: Hit[] = [];
  const rec = (request: Request) => {
    const u = new URL(request.url);
    hits.push({ path: u.pathname, search: u.searchParams });
    return u.searchParams;
  };
  server.use(
    http.get("*/api/admin/overview", ({ request }) => {
      rec(request);
      return HttpResponse.json(over.overview ?? overview);
    }),
    http.get("*/api/admin/live", ({ request }) => {
      rec(request);
      return HttpResponse.json(over.live ?? live);
    }),
    http.get("*/api/admin/system", ({ request }) => {
      rec(request);
      return HttpResponse.json(system);
    }),
    http.get("*/api/admin/users", ({ request }) => {
      const q = rec(request);
      const page = Number(q.get("page") ?? 1);
      const all = Array.from({ length: 30 }, (_, i) => userRow(i + 1)).filter(
        (u) => !q.get("q") || u.username.includes(q.get("q") as string),
      );
      return HttpResponse.json({
        items: all.slice((page - 1) * 25, page * 25),
        total: all.length,
        page,
        page_size: 25,
        sort: q.get("sort") ?? "created_at",
        order: q.get("order") ?? "desc",
        q: q.get("q") ?? "",
      });
    }),
    http.get("*/api/admin/servers", ({ request }) => {
      rec(request);
      return HttpResponse.json({
        items: [
          {
            id: "1",
            name: "Casa",
            owner: "ana",
            members: 3,
            channels: 4,
            messages: 80,
            invites_active: 1,
            created_at: "2026-10-02T10:00:00Z",
          },
        ],
        total: 1,
        page: 1,
        page_size: 25,
        sort: "created_at",
        order: "desc",
        q: "",
      });
    }),
    http.get("*/api/admin/calls", ({ request }) => {
      rec(request);
      return HttpResponse.json(
        over.calls ?? {
          generated_at: "2026-10-31T15:30:00Z",
          summary: live.calls,
          rooms: [
            {
              channel_id: "10",
              channel: "geral-voz",
              server: "Casa",
              dm: false,
              people: ["ana", "beto"],
              cameras: 1,
              screens: 0,
              started_at: "2026-10-31T15:00:00Z",
              duration_seconds: 1800,
            },
          ],
        },
      );
    }),
  );
  return hits;
}

const asAdmin = (admin: boolean) => ({
  signedIn: true,
  seed: (s: { user: { is_admin?: boolean } }) => {
    s.user.is_admin = admin;
  },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("guarda e link do painel", () => {
  it("quem não é admin é mandado para o início e não chama a API do painel", async () => {
    const hits = adminApi();
    const app = await renderApp("/admin", asAdmin(false));
    await waitFor(() => expect(app.router.state.location.pathname).toBe("/"));
    expect(hits).toHaveLength(0);
  });

  it("sem sessão vai para o login", async () => {
    adminApi();
    const app = await renderApp("/admin/users", { signedIn: false });
    await waitFor(() => expect(app.router.state.location.pathname).toBe("/login"));
  });

  it("o link do painel só aparece para admins", async () => {
    adminApi();
    await renderApp("/channels/@me", asAdmin(true));
    expect(await screen.findByRole("link", { name: "Painel de administração" })).toHaveAttribute(
      "href",
      "/admin",
    );
  });

  it("sem is_admin não há link", async () => {
    adminApi();
    await renderApp("/channels/@me", asAdmin(false));
    await screen.findByRole("navigation", { name: "Servidores" });
    expect(screen.queryByRole("link", { name: "Painel de administração" })).toBeNull();
  });
});

describe("dashboard", () => {
  it("mostra os cartões, os gráficos com tabela acessível e o bloco ao vivo", async () => {
    adminApi();
    await renderApp("/admin", asAdmin(true));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(await screen.findByText("Métricas e gráficos de todo o app.")).toBeInTheDocument();
    const users = (await screen.findByText("Usuários", { selector: "p" }))
      .parentElement as HTMLElement;
    expect(within(users).getByText("120")).toBeInTheDocument();
    expect(within(users).getByText(/\+11,1% em 7 dias/)).toBeInTheDocument();

    // Gráfico: 14 dias na tabela por trás, com o dia sem dado valendo 0.
    const chart = screen.getByRole("img", { name: /Novas contas por dia/ });
    expect(chart).toBeInTheDocument();
    const table = screen.getByRole("table", { name: "Novas contas por dia por dia (UTC)" });
    expect(within(table).getAllByRole("row")).toHaveLength(15);
    expect(
      within(table).getByRole("rowheader", { name: "2026-10-31" }).nextElementSibling,
    ).toHaveTextContent("4");
    expect(screen.getByText(/variação \+50%/)).toBeInTheDocument();

    const liveBlock = screen
      .getByRole("heading", { name: "Ao vivo agora" })
      .closest("section") as HTMLElement;
    expect(await within(liveBlock).findByText("Câmeras ligadas")).toBeInTheDocument();
    expect(
      within(liveBlock).getByText("Lido ao vivo do servidor LiveKit (atualiza a cada 5 s)"),
    ).toBeInTheDocument();

    // Prometheus indisponível: explica em vez de mostrar zeros.
    expect(await screen.findAllByText(/indisponível/)).not.toHaveLength(0);
    expect(screen.getByText("Aplicação e armazenamento")).toBeInTheDocument();
    expect(await screen.findByText("go1.26.0")).toBeInTheDocument();
    expect(screen.getByText("Usuários online")).toBeInTheDocument();
    expect(screen.getByText("Com falha (descartados)")).toBeInTheDocument();
    expect(screen.getByText(/Atualizado em \d\d:\d\d:\d\d/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ao vivo" })).toBeInTheDocument();
  });

  it("com o Prometheus do LiveKit mostra uso e saúde da mídia", async () => {
    adminApi({
      live: {
        ...live,
        livekit: {
          ...live.livekit,
          available: true,
          reason: undefined,
          rooms: 2,
          participants: 5,
          tracks_published: 7,
          bytes_in_per_sec: 125_000,
          packet_loss_pct: 0.5,
          jitter_ms: 3.2,
          rtt_ms: 40,
          quality_score: null,
        },
      },
    });
    await renderApp("/admin", asAdmin(true));
    expect(await screen.findByText("Entrada agora")).toBeInTheDocument();
    expect(screen.getByText("1 Mbps")).toBeInTheDocument();
    expect(screen.getByText("0,5%")).toBeInTheDocument();
    expect(screen.getByText("3,2 ms")).toBeInTheDocument();
    expect(screen.getByText("Nota de qualidade").nextElementSibling).toHaveTextContent("—");
  });

  it("repete as leituras ao vivo a cada 5 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const hits = adminApi();
    await renderApp("/admin", asAdmin(true));
    await screen.findByText("go1.26.0");
    const count = (p: string) => hits.filter((h) => h.path === p).length;
    expect(count("/api/admin/live")).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    await waitFor(() => expect(count("/api/admin/live")).toBeGreaterThanOrEqual(2));
    expect(count("/api/admin/system")).toBeGreaterThanOrEqual(2);
    // A visão geral (agregados caros) é mais lenta: ainda não repetiu.
    expect(count("/api/admin/overview")).toBe(1);
  });

  it("falha de leitura aparece como aviso", async () => {
    adminApi();
    server.use(
      http.get("*/api/admin/system", () => HttpResponse.json({ status: 500 }, { status: 500 })),
    );
    await renderApp("/admin", asAdmin(true));
    expect(await screen.findByText(/Alguma leitura falhou/)).toBeInTheDocument();
  });
});

describe("usuários", () => {
  it("lista, ordena, busca com debounce e pagina", async () => {
    const hits = adminApi();
    await renderApp("/admin/users", asAdmin(true));
    expect(await screen.findByText("@user1")).toBeInTheDocument();
    const users = () => hits.filter((h) => h.path === "/api/admin/users");
    expect(users()[0]?.search.get("sort")).toBe("created_at");
    expect(screen.getByText(/30 resultados · página 1 de 2/)).toBeInTheDocument();
    expect(screen.queryByText("@user30")).toBeNull();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Próxima" }));
    expect(await screen.findByText("@user30")).toBeInTheDocument();
    expect(users().at(-1)?.search.get("page")).toBe("2");

    // Ordenar por mensagens: 1º clique desc, 2º asc; volta para a página 1.
    await user.click(screen.getByRole("button", { name: /Mensagens/ }));
    await waitFor(() => expect(users().at(-1)?.search.get("sort")).toBe("messages_sent"));
    expect(users().at(-1)?.search.get("order")).toBe("desc");
    expect(users().at(-1)?.search.get("page")).toBe("1");
    expect(screen.getByRole("columnheader", { name: /Mensagens/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    await user.click(screen.getByRole("button", { name: /Mensagens/ }));
    await waitFor(() => expect(users().at(-1)?.search.get("order")).toBe("asc"));

    // Busca: só consulta depois do debounce, uma vez.
    const before = users().length;
    await user.type(
      screen.getByRole("searchbox", { name: "Buscar por usuário ou e-mail" }),
      "user2",
    );
    expect(users()).toHaveLength(before);
    await waitFor(() => expect(users().at(-1)?.search.get("q")).toBe("user2"));
    expect(users().length).toBe(before + 1);
    expect(await screen.findByText(/11 resultados/)).toBeInTheDocument();
  });

  it("não mostra nada além das colunas combinadas e trata lista vazia", async () => {
    adminApi();
    server.use(
      http.get("*/api/admin/users", () =>
        HttpResponse.json({
          items: [],
          total: 0,
          page: 1,
          page_size: 25,
          sort: "created_at",
          order: "desc",
          q: "",
        }),
      ),
    );
    await renderApp("/admin/users", asAdmin(true));
    expect(await screen.findByText("Nenhum usuário encontrado.")).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent?.trim())).toEqual([
      "Usuário",
      "E-mail",
      "Servidores",
      "Possui",
      "Mensagens",
      "Última atividade",
      "Entrou em",
    ]);
  });

  it("erro de leitura mostra mensagem", async () => {
    adminApi();
    server.use(
      http.get("*/api/admin/users", () => HttpResponse.json({ status: 500 }, { status: 500 })),
    );
    await renderApp("/admin/users", asAdmin(true));
    expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível carregar a lista");
  });
});

describe("servidores e chamadas", () => {
  it("lista servidores", async () => {
    adminApi();
    await renderApp("/admin/servers", asAdmin(true));
    expect(await screen.findByText("Casa")).toBeInTheDocument();
    expect(
      within(screen.getByRole("table", { name: "Servidores" })).getByText("@ana"),
    ).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: /Membros/ })).toBeInTheDocument();
  });

  it("mostra os cartões e a tabela de salas ativas, e filtra pela busca", async () => {
    const hits = adminApi();
    await renderApp("/admin/calls", asAdmin(true));
    expect(await screen.findByText("geral-voz")).toBeInTheDocument();
    expect(screen.getByText("Lido ao vivo do servidor LiveKit.")).toBeInTheDocument();
    expect(screen.getByText("@ana, @beto")).toBeInTheDocument();
    expect(screen.getByText("30 min 0 s")).toBeInTheDocument();
    expect(screen.getByText("Compartilhamentos de tela")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox", { name: /Buscar por servidor/ }), "casa");
    await waitFor(() =>
      expect(
        hits
          .filter((h) => h.path === "/api/admin/calls")
          .at(-1)
          ?.search.get("q"),
      ).toBe("casa"),
    );
  });

  it("voz desligada explica o motivo", async () => {
    adminApi({
      calls: {
        generated_at: "2026-10-31T15:30:00Z",
        summary: {
          available: false,
          reason: "voz desligada neste servidor",
          ongoing: 0,
          people: 0,
          cameras: 0,
          screens: 0,
        },
        rooms: [],
      },
    });
    await renderApp("/admin/calls", asAdmin(true));
    expect(await screen.findByText(/voz desligada neste servidor/)).toBeInTheDocument();
    expect(screen.getByText("Nenhuma chamada em andamento.")).toBeInTheDocument();
  });
});

describe("layout", () => {
  it("tem a barra lateral com os itens e o breadcrumb", async () => {
    adminApi();
    await renderApp("/admin/calls", asAdmin(true));
    const nav = await screen.findByRole("navigation", { name: "Administração" });
    for (const n of ["Dashboard", "Usuários", "Servidores", "Chamadas"]) {
      expect(within(nav).getByRole("link", { name: n })).toBeInTheDocument();
    }
    expect(screen.getByRole("link", { name: /Voltar ao app/ })).toHaveAttribute("href", "/");
    expect(screen.getByText("Painel de administração", { selector: "p" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "Você está em" })).getByText("Chamadas"),
    ).toHaveAttribute("aria-current", "page");
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Recolher a barra lateral" }));
    expect(screen.getByRole("button", { name: "Abrir a barra lateral" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });
});
