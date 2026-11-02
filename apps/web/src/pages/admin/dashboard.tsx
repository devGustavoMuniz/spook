import { useAdminLive, useAdminOverview, useAdminSystem } from "@spook/shared";
import {
  Camera,
  MessageSquare,
  MessagesSquare,
  MonitorUp,
  Phone,
  Server,
  Users,
} from "lucide-react";
import {
  formatBitrate,
  formatChange,
  formatDecimal,
  formatDuration,
  formatNumber,
} from "@/features/admin/format";
import {
  BarChart,
  ErrorNote,
  Facts,
  LiveStatus,
  Loading,
  PageHeader,
  Section,
  StatCard,
  Unavailable,
} from "@/features/admin/ui";
import { formatBytes } from "@/lib/file-size";
import { formatDateTime } from "@/lib/format";

const LIVE_MS = 5_000;
const HEAVY_MS = 30_000;

const dash = (v: number | null | undefined, f: (n: number) => string) =>
  v === null || v === undefined ? "—" : f(v);

export function AdminDashboardPage() {
  const overview = useAdminOverview({ query: { refetchInterval: HEAVY_MS, staleTime: 0 } });
  const live = useAdminLive({ query: { refetchInterval: LIVE_MS, staleTime: 0 } });
  const system = useAdminSystem({ query: { refetchInterval: LIVE_MS, staleTime: 0 } });
  const o = overview.data;
  const l = live.data;
  const sy = system.data;
  const updatedAt = Math.max(overview.dataUpdatedAt, live.dataUpdatedAt, system.dataUpdatedAt);
  const failed = overview.isError || live.isError || system.isError;

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

      <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
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
          tone={o?.users.growth_pct ? "up" : undefined}
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
        />
        <StatCard
          icon={MessageSquare}
          loading={overview.isPending}
          label="Mensagens (24 h)"
          value={o ? formatNumber(o.messages.last_24h) : "—"}
        />
        <StatCard
          icon={Phone}
          loading={live.isPending}
          label="Chamadas em andamento"
          value={l?.calls.available ? formatNumber(l.calls.ongoing) : "—"}
        />
        <StatCard
          icon={Users}
          loading={live.isPending}
          label="Pessoas em chamadas"
          value={l?.calls.available ? formatNumber(l.calls.people) : "—"}
        />
      </div>

      {o ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
          <BarChart
            title="Novas contas por dia"
            days={o.new_users_per_day ?? []}
            trend={o.new_users_trend}
          />
          <BarChart
            title="Mensagens por dia"
            days={o.messages_per_day ?? []}
            trend={o.messages_trend}
          />
        </div>
      ) : overview.isPending ? (
        <Loading className="mt-6" rows={5} />
      ) : null}

      <Section
        className="mt-6"
        title="Ao vivo agora"
        hint="Lido ao vivo do servidor LiveKit (atualiza a cada 5 s)"
      >
        {l ? (
          l.calls.available ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <StatCard label="Chamadas em andamento" value={formatNumber(l.calls.ongoing)} />
              <StatCard label="Pessoas em chamadas" value={formatNumber(l.calls.people)} />
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
      </Section>

      {o ? (
        <div className="mt-6 grid gap-4 lg:grid-cols-2">
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
      ) : null}

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
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
              <Facts
                items={[
                  [
                    "Perda de pacotes",
                    dash(l.livekit.packet_loss_pct, (n) => `${formatDecimal(n)}%`),
                  ],
                  ["Jitter", dash(l.livekit.jitter_ms, (n) => `${formatDecimal(n)} ms`)],
                  ["RTT", dash(l.livekit.rtt_ms, (n) => `${formatDecimal(n)} ms`)],
                  [
                    "Nota de qualidade",
                    dash(l.livekit.quality_score, (n) => `${formatDecimal(n)} / 5`),
                  ],
                ]}
              />
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

      <h2 className="mt-10 mb-3 text-lg font-semibold tracking-tight">Aplicação e armazenamento</h2>
      {sy ? (
        <div className="grid gap-4 lg:grid-cols-2">
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
                ["Memória (RSS)", sy.app.rss_bytes === null ? "—" : formatBytes(sy.app.rss_bytes)],
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
          <Section title="Banco de dados" hint="Tamanho em cache por 60 s">
            <Facts
              items={[
                ["Tamanho do banco", formatBytes(sy.database.size_bytes)],
                ...(sy.database.pool
                  ? ([
                      ["Conexões em uso", `${sy.database.pool.in_use} de ${sy.database.pool.max}`],
                      [
                        "Conexões abertas / ociosas",
                        `${sy.database.pool.open} / ${sy.database.pool.idle}`,
                      ],
                      ["Esperas por conexão", formatNumber(sy.database.pool.wait_count)],
                    ] as [string, string][])
                  : []),
              ]}
            />
            <table className="mt-3 w-full text-left text-xs">
              <caption className="sr-only">Maiores tabelas</caption>
              <thead>
                <tr className="text-muted-foreground">
                  <th scope="col" className="py-1 font-medium">
                    Maiores tabelas
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Linhas (est.)
                  </th>
                  <th scope="col" className="py-1 text-right font-medium">
                    Tamanho
                  </th>
                </tr>
              </thead>
              <tbody>
                {(sy.database.tables ?? []).map((t) => (
                  <tr key={t.name} className="border-t">
                    <th scope="row" className="py-1 font-normal">
                      {t.name}
                    </th>
                    <td className="py-1 text-right tabular-nums">
                      {formatNumber(t.rows_estimate)}
                    </td>
                    <td className="py-1 text-right tabular-nums">{formatBytes(t.bytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Section>
          <div className="grid gap-4">
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
          </div>
        </div>
      ) : system.isPending ? (
        <Loading rows={6} />
      ) : null}
    </>
  );
}
