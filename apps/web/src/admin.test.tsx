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

const isoAt = (i: number) => new Date(Date.UTC(2026, 9, 31, 0, i * 5)).toISOString();
const historyPoints = Array.from({ length: 6 }, (_, i) => ({
  ts: isoAt(i),
  rooms: 1,
  participants: i,
  tracks_published: 2,
  tracks_subscribed: 3,
  bytes_out: 3000 * i,
  bytes_in: 1000,
  bytes_out_per_sec: 10 * i,
  peak_out_per_sec: 20 * i,
  packets_per_sec: 5,
  packet_loss_pct: null,
  jitter_ms: null,
  rtt_ms: null,
  has_media: true,
}));
const livekitHistory = (range: string, over: object = {}) => ({
  generated_at: "2026-10-31T15:30:00Z",
  range,
  bucket_seconds: range === "24h" ? 300 : range === "7d" ? 3600 : 86400,
  collecting: false,
  points: historyPoints,
  ...over,
});
const gatewayHistory = {
  generated_at: "2026-10-31T15:30:00Z",
  bucket_seconds: 300,
  collecting: false,
  points: Array.from({ length: 4 }, (_, i) => ({
    ts: isoAt(i),
    online_users: 2 + i,
    connections: 3 + i,
  })),
};
const heatmap = {
  generated_at: "2026-10-31T15:30:00Z",
  days: 28,
  total: 130,
  cells: Array.from({ length: 7 }, (_, d) =>
    Array.from({ length: 24 }, (_, h) => (d === 2 && h === 14 ? 50 : (d + h) % 5)),
  ),
};
const topServers = {
  generated_at: "2026-10-31T15:30:00Z",
  days: 7,
  items: [
    { id: "1", name: "Casa", messages: 900, members: 12 },
    { id: "2", name: "Clube", messages: 300, members: 1 },
  ],
};
const plan = {
  generated_at: "2026-10-31T15:30:00Z",
  collecting: false,
  peak_out_24h_per_sec: 250_000,
  month_start: "2026-10-01T00:00:00Z",
  month_bytes_out: 40_000_000_000,
  month_bytes_in: 5_000_000_000,
  monthly_limit_bytes: 100_000_000_000,
  month_pct: 40,
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
function adminApi(
  over: {
    overview?: unknown;
    live?: unknown;
    calls?: unknown;
    system?: unknown;
    history?: (range: string) => object;
    gateway?: unknown;
    heatmap?: unknown;
    top?: unknown;
    plan?: unknown;
  } = {},
) {
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
      return HttpResponse.json(over.system ?? system);
    }),
    http.get("*/api/admin/livekit/history", ({ request }) => {
      const q = rec(request);
      const range = q.get("range") ?? "24h";
      return HttpResponse.json(over.history ? over.history(range) : livekitHistory(range));
    }),
    http.get("*/api/admin/gateway/history", ({ request }) => {
      rec(request);
      return HttpResponse.json(over.gateway ?? gatewayHistory);
    }),
    http.get("*/api/admin/activity/heatmap", ({ request }) => {
      rec(request);
      return HttpResponse.json(over.heatmap ?? heatmap);
    }),
    http.get("*/api/admin/servers/top", ({ request }) => {
      rec(request);
      return HttpResponse.json(over.top ?? topServers);
    }),
    http.get("*/api/admin/livekit/usage", ({ request }) => {
      rec(request);
      return HttpResponse.json(over.plan ?? plan);
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

  it("organiza em grupos, com gauges, barras, sparklines e a comparação com 7 dias antes", async () => {
    adminApi();
    await renderApp("/admin", asAdmin(true));
    await screen.findByText("go1.26.0");
    for (const g of [
      "Resumo",
      "Crescimento",
      "Atividade",
      "Histórico",
      "Conteúdo",
      "Mídia",
      "Aplicação e armazenamento",
    ]) {
      expect(screen.getByRole("heading", { level: 2, name: g })).toBeInTheDocument();
    }
    // Séries com a linha de comparação (7 dias antes) e o rótulo na legenda.
    expect(screen.getAllByTestId("previous-line")).toHaveLength(2);
    expect(screen.getAllByText("7 dias antes").length).toBeGreaterThan(0);
    // Variação percentual com seta no cartão (alta: 200% nas mensagens).
    const msgCard = screen.getByText("Mensagens (7 dias)", { selector: "p" })
      .parentElement as HTMLElement;
    expect(within(msgCard).getByText(/\+200% vs\. 6 dias antes/)).toBeInTheDocument();
    // Medidores de capacidade: heap 10 MB de ~28,6 MB e pool 1 de 10 (10%).
    expect(screen.getByRole("meter", { name: "Pool de conexões do Postgres" })).toHaveAttribute(
      "aria-valuetext",
      "10%, Bom",
    );
    expect(screen.getByRole("meter", { name: "Memória da aplicação" })).toBeInTheDocument();
    // Maiores tabelas em barras, com tabela acessível.
    expect(screen.getByRole("table", { name: "Maiores tabelas" })).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Itens armazenados por tipo" })).toBeInTheDocument();
    // Cartões ao vivo com sparkline: a 1ª leitura ainda não forma linha (precisa de 2 amostras).
    expect(screen.getByText("Conexões do gateway")).toBeInTheDocument();
  });

  it("acumula amostras a cada leitura e desenha a sparkline do cartão", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    adminApi();
    await renderApp("/admin", asAdmin(true));
    await screen.findByText("go1.26.0");
    expect(screen.queryByRole("img", { name: /^Goroutines, últimos minutos/ })).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_100);
    });
    expect(
      await screen.findByRole("img", {
        name: /^Goroutines, últimos minutos: mínimo 42, máximo 42, atual 42/,
      }),
    ).toBeInTheDocument();
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
    expect(screen.getByRole("meter", { name: "Perda de pacotes" })).toHaveAttribute(
      "aria-valuetext",
      "0,5%, Bom",
    );
    expect(screen.getByRole("meter", { name: "Jitter" })).toHaveAttribute("aria-valuenow", "3.2");
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

describe("dashboard: histórico, atividade e capacidade", () => {
  it("liga o mapa de calor, o ranking de servidores e os gráficos do histórico, sem os avisos de 'dados virão do backend'", async () => {
    adminApi();
    await renderApp("/admin", asAdmin(true));
    await screen.findByText("go1.26.0");

    // Mapa de calor (hora x dia da semana) com a tabela acessível por baixo.
    expect(
      await screen.findByRole("grid", { name: "Mensagens por hora e dia da semana" }),
    ).toBeInTheDocument();
    // Ranking de servidores: barras com tabela.
    const rank = await screen.findByRole("table", {
      name: "Servidores com mais mensagens em 7 dias",
    });
    expect(within(rank).getByText("Casa")).toBeInTheDocument();
    expect(within(rank).getByText("Clube")).toBeInTheDocument();
    // Histórico: participantes, tráfego de saída e gateway (24 h).
    expect(
      await screen.findByRole("img", { name: /Participantes em chamadas/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Tráfego de saída do LiveKit/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Pessoas online no gateway/ })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /Conexões WebSocket/ })).toBeInTheDocument();
    // Os avisos antigos sumiram.
    expect(screen.queryByText(/chegam quando o backend/)).toBeNull();
    expect(screen.queryByText(/ainda não é medido pelo backend/)).toBeNull();
    expect(screen.queryByText(/O Spook não tem/)).toBeNull();
  });

  it("o seletor troca a janela do histórico (24 h, 7 dias, 30 dias) e pede à API com o intervalo certo", async () => {
    const hits = adminApi();
    await renderApp("/admin", asAdmin(true));
    await screen.findByRole("img", { name: /Participantes em chamadas/ });
    const hist = () => hits.filter((h) => h.path === "/api/admin/livekit/history");
    expect(hist().at(-1)?.search.get("range")).toBe("24h");
    await userEvent.click(screen.getByRole("tab", { name: "7 dias" }));
    await waitFor(() => expect(hist().at(-1)?.search.get("range")).toBe("7d"));
    expect((await screen.findAllByText(/Pontos de 1 hora/, { selector: "p" })).length).toBe(2);
    await userEvent.click(screen.getByRole("tab", { name: "30 dias" }));
    await waitFor(() => expect(hist().at(-1)?.search.get("range")).toBe("30d"));
    expect(screen.getByRole("tab", { name: "30 dias" })).toHaveAttribute("aria-selected", "true");
  });

  it("enquanto o histórico acumula mostra 'Coletando dados…' em vez de gráficos vazios", async () => {
    adminApi({
      history: (range) => livekitHistory(range, { collecting: true, points: [] }),
      gateway: { ...gatewayHistory, collecting: true, points: [] },
      plan: { ...plan, collecting: true, month_bytes_out: 0, month_pct: 0 },
    });
    await renderApp("/admin", asAdmin(true));
    expect((await screen.findAllByText(/Coletando dados…/)).length).toBeGreaterThanOrEqual(4);
  });

  it("capacidade: disco, plano do LiveKit (mês contra o limite) e pico de saída em 24 h", async () => {
    adminApi({
      system: {
        ...system,
        disk: {
          path: "/data",
          total_bytes: 100_000_000_000,
          free_bytes: 15_000_000_000,
          used_bytes: 85_000_000_000,
          used_pct: 85,
        },
        storage: {
          ...system.storage,
          objects: {
            avatars_bytes: 2_097_152,
            icons_bytes: 1_048_576,
            banners_bytes: null,
            truncated: false,
          },
        },
      },
    });
    await renderApp("/admin", asAdmin(true));
    const disk = await screen.findByRole("meter", { name: "Disco do volume de dados" });
    expect(disk).toHaveAttribute("aria-valuetext", "85%, Atenção");
    const month = await screen.findByRole("meter", { name: "Tráfego do mês (plano do LiveKit)" });
    expect(month).toHaveAttribute("aria-valuetext", "40%, Bom");
    expect(
      screen.getByText(/de 93,1 GB de saída|de 100 GB de saída|de .* de saída/),
    ).toBeInTheDocument();
    expect(screen.getByText("Pico de saída em 24 h")).toBeInTheDocument();
    expect(screen.getByText("2 Mbps")).toBeInTheDocument(); // 250 kB/s = 2 Mbps
    expect(screen.getByText("Avatares (bytes)")).toBeInTheDocument();
    expect(screen.getByText("Banners (bytes)")).toBeInTheDocument();
  });

  it("sem disco medido nem limite do plano explica em vez de inventar números", async () => {
    adminApi({ plan: { ...plan, monthly_limit_bytes: null, month_pct: null } });
    await renderApp("/admin", asAdmin(true));
    expect(await screen.findByText("disco não medido neste sistema")).toBeInTheDocument();
    expect(await screen.findByText("não configurado")).toBeInTheDocument();
    expect(screen.getByText(/LIVEKIT_MONTHLY_TRAFFIC_GB/)).toBeInTheDocument();
    expect(screen.queryByRole("meter", { name: "Tráfego do mês (plano do LiveKit)" })).toBeNull();
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
    expect(screen.getByRole("button", { name: "Tentar de novo" })).toBeInTheDocument();
  });

  it("cabeçalho fixo, números tabulares e coluna ordenada com indicador (aria-sort)", async () => {
    adminApi();
    await renderApp("/admin/users", asAdmin(true));
    await screen.findByText("@user1");
    const table = screen.getByRole("table", { name: "Usuários" });
    expect(table.querySelector("thead")).toHaveClass("sticky");
    expect(screen.getByRole("columnheader", { name: /Entrou em/ })).toHaveAttribute(
      "aria-sort",
      "descending",
    );
    expect(table.parentElement).toHaveClass("scroll-shadow-x");
    expect(within(table).getAllByRole("cell")[2]).toHaveClass("tabular");
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
    // Mini-visualizações: pessoas por sala (2) e duração (30 min), cada uma com tabela acessível.
    const people = screen.getByRole("table", { name: "Pessoas por sala" });
    expect(
      within(people).getByRole("rowheader", { name: "Casa · geral-voz" }).nextElementSibling,
    ).toHaveTextContent("2");
    const dur = screen.getByRole("table", { name: "Duração das chamadas" });
    expect(
      within(dur).getByRole("rowheader", { name: "Casa · geral-voz" }).nextElementSibling,
    ).toHaveTextContent("30 min");
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
    expect(screen.queryByRole("table", { name: "Pessoas por sala" })).toBeNull();
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
