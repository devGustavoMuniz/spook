import { useAdminLive, useAdminOverview, useAdminSystem } from "@spook/shared";
import {
  Activity,
  Camera,
  Cpu,
  MessageSquare,
  MessagesSquare,
  MonitorUp,
  Phone,
  Plug,
  Server,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";
import { type BarItem, BarList, Gauge, Sparkline, TimeSeriesChart } from "@/components/charts";
import {
  formatBitrate,
  formatChange,
  formatDecimal,
  formatDuration,
  formatNumber,
  shortDay,
} from "@/features/admin/format";
import {
  ErrorNote,
  Facts,
  LiveStatus,
  Loading,
  PageHeader,
  Section,
  StatCard,
  Unavailable,
} from "@/features/admin/ui";
import { useRollingSamples } from "@/features/admin/use-samples";
import { formatBytes } from "@/lib/file-size";
import { formatDateTime } from "@/lib/format";

const LIVE_MS = 5_000;
const HEAVY_MS = 30_000;

const dash = (v: number | null | undefined, f: (n: number) => string) =>
  v === null || v === undefined ? "—" : f(v);

const pct = (n: number) => `${formatDecimal(n)}%`;

/** Título de grupo da página (hierarquia: grupo → bloco → número). */
function Group({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <div className="mt-10">
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

type Day = { date: string; count: number };

/** Série dos últimos dias + o mesmo intervalo 7 dias antes (alinhado por índice) como comparação. */
function growthSeries(days: Day[]) {
  return {
    points: days.map((d) => ({ key: d.date, label: shortDay(d.date), value: d.count })),
    previous: days.map((_, i) => (i >= 7 ? (days[i - 7] as Day).count : null)),
  };
}

export function AdminDashboardPage() {
  const overview = useAdminOverview({ query: { refetchInterval: HEAVY_MS, staleTime: 0 } });
  const live = useAdminLive({ query: { refetchInterval: LIVE_MS, staleTime: 0 } });
  const system = useAdminSystem({ query: { refetchInterval: LIVE_MS, staleTime: 0 } });
  const o = overview.data;
  const l = live.data;
  const sy = system.data;
  const updatedAt = Math.max(overview.dataUpdatedAt, live.dataUpdatedAt, system.dataUpdatedAt);
  const failed = overview.isError || live.isError || system.isError;

  // Amostras acumuladas a cada leitura (janela de ~5 min, só em memória).
  const peopleHist = useRollingSamples(
    l?.calls.available ? l.calls.people : null,
    live.dataUpdatedAt,
  );
  const connHist = useRollingSamples(
    sy?.gateway.available ? sy.gateway.connections : null,
    system.dataUpdatedAt,
  );
  const onlineHist = useRollingSamples(
    sy?.gateway.available ? sy.gateway.online_users : null,
    system.dataUpdatedAt,
  );
  const goroutineHist = useRollingSamples(sy?.app.goroutines, system.dataUpdatedAt);
  const heapHist = useRollingSamples(sy?.app.heap_bytes, system.dataUpdatedAt);

  const users = o ? growthSeries(o.new_users_per_day ?? []) : null;
  const msgs = o ? growthSeries(o.messages_per_day ?? []) : null;

  const tableBars: BarItem[] = (sy?.database.tables ?? []).map((t) => ({
    key: t.name,
    label: t.name,
    value: t.bytes,
    display: formatBytes(t.bytes),
    detail: `${formatNumber(t.rows_estimate)} linhas (est.)`,
  }));
  const storageBars: BarItem[] = sy
    ? [
        {
          key: "attachments",
          label: "Anexos",
          value: sy.storage.attachment_count,
          display: formatNumber(sy.storage.attachment_count),
          detail: formatBytes(sy.storage.attachment_bytes),
        },
        {
          key: "avatars",
          label: "Avatares",
          value: sy.storage.avatars,
          display: formatNumber(sy.storage.avatars),
          detail: "tamanho não medido",
        },
        {
          key: "icons",
          label: "Ícones de servidor",
          value: sy.storage.guild_icons,
          display: formatNumber(sy.storage.guild_icons),
          detail: "tamanho não medido",
        },
      ]
    : [];
  const heapPct = sy && sy.app.sys_bytes > 0 ? (sy.app.heap_bytes / sy.app.sys_bytes) * 100 : null;
  const poolPct =
    sy?.database.pool && sy.database.pool.max > 0
      ? (sy.database.pool.in_use / sy.database.pool.max) * 100
      : null;

  return (
    <>
      <PageHeader title="Dashboard" subtitle="Métricas e gráficos de todo o app.">
        <LiveStatus
          updatedAt={updatedAt}
          fetching={overview.isFetching || live.isFetching || system.isFetching}
          failed={failed}
        />
      </PageHeader>
      {failed ? (
        <ErrorNote>Alguma leitura falhou; os números abaixo podem estar desatualizados.</ErrorNote>
      ) : null}

      <h2 className="sr-only">Resumo</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          icon={Users}
          loading={overview.isPending}
          label="Usuários"
          value={o ? formatNumber(o.users.total) : "—"}
          detail={
            o
              ? `${formatChange(o.users.growth_pct)} em 7 dias · ${formatNumber(o.users.new_7d)} contas novas`
              : undefined
          }
          tone={deltaTone(o?.users.growth_pct)}
        />
        <StatCard
          icon={Server}
          loading={overview.isPending}
          label="Servidores"
          value={o ? formatNumber(o.servers.total) : "—"}
          detail={o ? `${formatNumber(o.servers.memberships)} participações` : undefined}
        />
        <StatCard
          icon={MessagesSquare}
          loading={overview.isPending}
          label="Mensagens (7 dias)"
          value={o ? formatNumber(o.messages.last_7d) : "—"}
          detail={o ? `${formatChange(o.messages_trend.change_pct)} vs. 6 dias antes` : undefined}
          tone={deltaTone(o?.messages_trend.change_pct)}
        />
        <StatCard
          icon={MessageSquare}
          loading={overview.isPending}
          label="Mensagens (24 h)"
          value={o ? formatNumber(o.messages.last_24h) : "—"}
          detail={o ? `${formatNumber(o.users.new_24h)} contas novas em 24 h` : undefined}
        />
      </div>

      <Section
        className="mt-6"
        title="Ao vivo agora"
        hint="Lido ao vivo do servidor LiveKit (atualiza a cada 5 s)"
      >
        {l ? (
          l.calls.available ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                icon={Phone}
                label="Chamadas em andamento"
                value={formatNumber(l.calls.ongoing)}
              />
              <StatCard
                icon={Users}
                label="Pessoas em chamadas"
                value={formatNumber(l.calls.people)}
                spark={<Sparkline values={peopleHist} label="Pessoas em chamadas" />}
              />
              <StatCard
                icon={Camera}
                label="Câmeras ligadas"
                value={formatNumber(l.calls.cameras)}
              />
              <StatCard
                icon={MonitorUp}
                label="Compartilhamentos de tela"
                value={formatNumber(l.calls.screens)}
              />
            </div>
          ) : (
            <Unavailable title="Chamadas ao vivo" reason={l.calls.reason} />
          )
        ) : (
          <Loading />
        )}
        {sy ? (
          sy.gateway.available ? (
            <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard
                icon={Plug}
                label="Conexões do gateway"
                value={formatNumber(sy.gateway.connections)}
                spark={<Sparkline values={connHist} label="Conexões do gateway" />}
              />
              <StatCard
                icon={Users}
                label="Pessoas online"
                value={formatNumber(sy.gateway.online_users)}
                spark={<Sparkline values={onlineHist} label="Pessoas online" />}
              />
              <StatCard
                icon={Activity}
                label="Goroutines"
                value={formatNumber(sy.app.goroutines)}
                spark={<Sparkline values={goroutineHist} label="Goroutines" />}
              />
              <StatCard
                icon={Cpu}
                label="Memória (heap)"
                value={formatBytes(sy.app.heap_bytes)}
                spark={<Sparkline values={heapHist} label="Memória (heap)" format={formatBytes} />}
              />
            </div>
          ) : null
        ) : system.isPending ? (
          <Loading className="mt-4" rows={2} />
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          As miniaturas guardam as últimas leituras desta aba (cerca de 5 min) e recomeçam ao
          recarregar.
        </p>
      </Section>

      <Group
        title="Crescimento"
        hint="Últimos 14 dias (UTC). A linha tracejada é o mesmo intervalo 7 dias antes."
      >
        {o && users && msgs ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Novas contas por dia" hint={trendHint(o.new_users_trend)}>
              <TimeSeriesChart
                title="Novas contas por dia"
                points={users.points}
                previous={users.previous}
                previousLabel="7 dias antes"
                seriesLabel="Contas novas"
                lastPartial
                formatValue={formatNumber}
              />
              <TrendLine trend={o.new_users_trend} />
            </Section>
            <Section title="Mensagens por dia" hint={trendHint(o.messages_trend)}>
              <TimeSeriesChart
                title="Mensagens por dia"
                points={msgs.points}
                previous={msgs.previous}
                previousLabel="7 dias antes"
                seriesLabel="Mensagens"
                lastPartial
                formatValue={formatNumber}
              />
              <TrendLine trend={o.messages_trend} />
            </Section>
          </div>
        ) : overview.isPending ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Novas contas por dia">
              <TimeSeriesChart title="Novas contas por dia" points={[]} loading />
            </Section>
            <Section title="Mensagens por dia">
              <TimeSeriesChart title="Mensagens por dia" points={[]} loading />
            </Section>
          </div>
        ) : null}
        <p className="mt-3 text-xs text-muted-foreground">
          Mensagens por hora e dia da semana (mapa de calor) e o histórico do LiveKit chegam quando
          o backend passar a guardar essas séries.
        </p>
      </Group>

      {o ? (
        <Group title="Conteúdo">
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Contas">
              <Facts
                items={[
                  ["Cadastrados", formatNumber(o.accounts.registered)],
                  ["Com avatar", formatNumber(o.accounts.with_avatar)],
                  ["Administradores", formatNumber(o.accounts.admins)],
                  ["Novos em 24 h", formatNumber(o.users.new_24h)],
                ]}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                O Spook não tem verificação de e-mail nem login social.
              </p>
            </Section>
            <Section title="Servidores e canais">
              <Facts
                items={[
                  ["Servidores", formatNumber(o.servers.total)],
                  ["Participações", formatNumber(o.servers.memberships)],
                  ["Canais de texto", formatNumber(o.servers.text_channels)],
                  ["Canais de voz", formatNumber(o.servers.voice_channels)],
                  ["Categorias", formatNumber(o.servers.categories)],
                  ["Cargos", formatNumber(o.servers.roles)],
                  ["Convites ativos", formatNumber(o.servers.active_invites)],
                  ["Usos de convites", formatNumber(o.servers.invite_uses)],
                ]}
              />
            </Section>
            <Section title="Mensagens">
              <Facts
                items={[
                  ["Total", formatNumber(o.messages.total)],
                  ["Em 24 h", formatNumber(o.messages.last_24h)],
                  ["Em 7 dias", formatNumber(o.messages.last_7d)],
                  ["Em servidores", formatNumber(o.messages.in_guilds)],
                  ["Em conversas diretas", formatNumber(o.messages.in_dms)],
                  ["Anexos", formatNumber(o.attachments.count)],
                  ["Tamanho dos anexos", formatBytes(o.attachments.bytes)],
                ]}
              />
            </Section>
            <Section title="Conversas diretas">
              <Facts
                items={[
                  ["Conversas 1:1", formatNumber(o.conversations.direct)],
                  ["Grupos", formatNumber(o.conversations.groups)],
                ]}
              />
              <p className="mt-2 text-xs text-muted-foreground">
                O Spook não tem amizades, pedidos nem bloqueios.
              </p>
            </Section>
          </div>
        </Group>
      ) : null}

      <Group title="Mídia" hint="Servidor LiveKit">
        <div className="grid gap-4 lg:grid-cols-2">
          <Section
            title="Uso do servidor LiveKit"
            hint="Lido do endpoint Prometheus do LiveKit (rede interna)"
          >
            {l ? (
              l.livekit.available ? (
                <Facts
                  items={[
                    ["Salas", formatNumber(l.livekit.rooms)],
                    ["Participantes", formatNumber(l.livekit.participants)],
                    ["Faixas publicadas", formatNumber(l.livekit.tracks_published)],
                    ["Faixas assinadas", formatNumber(l.livekit.tracks_subscribed)],
                    ["Tráfego de entrada", formatBytes(l.livekit.bytes_in)],
                    ["Tráfego de saída", formatBytes(l.livekit.bytes_out)],
                    ["Entrada agora", formatBitrate(l.livekit.bytes_in_per_sec)],
                    ["Saída agora", formatBitrate(l.livekit.bytes_out_per_sec)],
                    ["Pacotes", formatNumber(l.livekit.packets_in + l.livekit.packets_out)],
                    ["Pacotes por segundo", formatDecimal(l.livekit.packets_per_sec)],
                  ]}
                />
              ) : (
                <Unavailable title="Prometheus do LiveKit" reason={l.livekit.reason} />
              )
            ) : (
              <Loading />
            )}
          </Section>
          <Section title="Saúde da mídia" hint="Médias desde o boot do LiveKit">
            {l ? (
              l.livekit.available ? (
                <>
                  <div className="grid grid-cols-2 gap-4">
                    <Gauge
                      label="Perda de pacotes"
                      value={l.livekit.packet_loss_pct ?? null}
                      max={5}
                      warnAt={1}
                      badAt={3}
                      format={pct}
                      hint="bom até 1%, ruim a partir de 3%"
                    />
                    <Gauge
                      label="Jitter"
                      value={l.livekit.jitter_ms ?? null}
                      max={100}
                      warnAt={20}
                      badAt={50}
                      format={(n) => `${formatDecimal(n)} ms`}
                      hint="bom até 20 ms, ruim a partir de 50 ms"
                    />
                  </div>
                  <div className="mt-4">
                    <Facts
                      items={[
                        ["RTT", dash(l.livekit.rtt_ms, (n) => `${formatDecimal(n)} ms`)],
                        [
                          "Nota de qualidade",
                          dash(l.livekit.quality_score, (n) => `${formatDecimal(n)} / 5`),
                        ],
                      ]}
                    />
                  </div>
                </>
              ) : (
                <Unavailable title="Saúde da mídia" reason={l.livekit.reason} />
              )
            ) : (
              <Loading />
            )}
            <p className="mt-2 text-xs text-muted-foreground">
              "—" quando o LiveKit ainda não expôs a métrica (sem tráfego de mídia).
            </p>
          </Section>
        </div>
      </Group>

      <Group title="Aplicação e armazenamento">
        {sy ? (
          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="Capacidade" hint="Uso atual contra o limite; atualiza a cada 5 s">
              <div className="grid grid-cols-2 gap-4">
                <Gauge
                  label="Memória da aplicação"
                  value={heapPct}
                  max={100}
                  warnAt={70}
                  badAt={90}
                  format={pct}
                  hint={`${formatBytes(sy.app.heap_bytes)} de ${formatBytes(sy.app.sys_bytes)}`}
                />
                <Gauge
                  label="Pool de conexões do Postgres"
                  value={poolPct}
                  max={100}
                  warnAt={70}
                  badAt={90}
                  format={pct}
                  hint={
                    sy.database.pool
                      ? `${sy.database.pool.in_use} de ${sy.database.pool.max} em uso`
                      : "sem leitura do pool"
                  }
                />
              </div>
              <p className="mt-3 text-xs text-muted-foreground">
                Uso de disco do servidor ainda não é medido pelo backend.
              </p>
            </Section>
            <Section title="Aplicação" hint="Atualiza a cada 5 s">
              <Facts
                items={[
                  [
                    "Versão",
                    <span key="v" className="break-all">
                      {sy.app.version}
                    </span>,
                  ],
                  ["Commit", sy.app.commit],
                  ["Ambiente", sy.app.environment],
                  ["Hora do servidor", formatDateTime(sy.app.server_time)],
                  ["Uptime", formatDuration(sy.app.uptime_seconds)],
                  ["Go", sy.app.go_version],
                  ["Goroutines", formatNumber(sy.app.goroutines)],
                  ["Memória (heap)", formatBytes(sy.app.heap_bytes)],
                  [
                    "Memória (RSS)",
                    sy.app.rss_bytes === null ? "—" : formatBytes(sy.app.rss_bytes),
                  ],
                ]}
              />
            </Section>
            <Section title="Gateway (WebSocket)">
              {sy.gateway.available ? (
                <Facts
                  items={[
                    ["Conexões abertas", formatNumber(sy.gateway.connections)],
                    ["Sessões", formatNumber(sy.gateway.sessions)],
                    ["Usuários online", formatNumber(sy.gateway.online_users)],
                    ["Eventos por segundo", formatDecimal(sy.gateway.events_per_second)],
                    ["Eventos desde o boot", formatNumber(sy.gateway.events_total)],
                  ]}
                />
              ) : (
                <Unavailable title="Gateway" />
              )}
            </Section>
            <Section title="Fila de jobs (River)">
              {sy.jobs.available ? (
                <Facts
                  items={[
                    ["Disponíveis", formatNumber(sy.jobs.pending)],
                    ["Em execução", formatNumber(sy.jobs.running)],
                    ["Agendados", formatNumber(sy.jobs.scheduled)],
                    ["Com nova tentativa", formatNumber(sy.jobs.retryable)],
                    ["Com falha (descartados)", formatNumber(sy.jobs.failed)],
                  ]}
                />
              ) : (
                <Unavailable
                  title="Fila de jobs"
                  reason="As tabelas do River não existem neste banco."
                />
              )}
            </Section>
            <Section title="Banco de dados" hint="Tamanho em cache por 60 s">
              <Facts
                items={[
                  ["Tamanho do banco", formatBytes(sy.database.size_bytes)],
                  ...(sy.database.pool
                    ? ([
                        [
                          "Conexões em uso",
                          `${sy.database.pool.in_use} de ${sy.database.pool.max}`,
                        ],
                        [
                          "Conexões abertas / ociosas",
                          `${sy.database.pool.open} / ${sy.database.pool.idle}`,
                        ],
                        ["Esperas por conexão", formatNumber(sy.database.pool.wait_count)],
                      ] as [string, string][])
                    : []),
                ]}
              />
              <h3 className="mt-4 mb-1 text-sm font-medium">Maiores tabelas</h3>
              <BarList
                title="Maiores tabelas"
                items={tableBars}
                valueHeader="Tamanho"
                emptyText="Sem tabelas para listar."
              />
            </Section>
            <Section
              title="Armazenamento"
              hint="Anexos têm tamanho no banco; avatares e ícones só a contagem"
            >
              <Facts
                items={[
                  ["Anexos", formatNumber(sy.storage.attachment_count)],
                  ["Tamanho dos anexos", formatBytes(sy.storage.attachment_bytes)],
                  ["Avatares", formatNumber(sy.storage.avatars)],
                  ["Ícones de servidor", formatNumber(sy.storage.guild_icons)],
                ]}
              />
              <h3 className="mt-4 mb-1 text-sm font-medium">Itens por tipo</h3>
              <BarList title="Itens armazenados por tipo" items={storageBars} valueHeader="Itens" />
            </Section>
          </div>
        ) : system.isPending ? (
          <Loading rows={6} />
        ) : null}
      </Group>
    </>
  );
}

function deltaTone(pctChange: number | null | undefined): "up" | "down" | undefined {
  if (!pctChange) return undefined;
  return pctChange > 0 ? "up" : "down";
}

function trendHint(t: { recent: number; previous: number; change_pct: number | null }) {
  return `Últimos 6 dias completos: ${t.recent} · 6 anteriores: ${t.previous} · variação ${formatChange(t.change_pct)}`;
}

function TrendLine({ trend }: { trend: { change_pct: number | null } }) {
  const c = trend.change_pct;
  return (
    <p
      className={`mt-1 text-xs ${c !== null && c > 0 ? "text-success-text" : c !== null && c < 0 ? "text-destructive-text" : "text-muted-foreground"}`}
    >
      {c !== null && c > 0
        ? "Em alta"
        : c !== null && c < 0
          ? "Em queda"
          : "Estável ou sem base de comparação"}{" "}
      · hoje (ponto vazado) ainda não terminou
    </p>
  );
}
