import {
  type AdminLiveKitHistoryRange,
  useAdminActivityHeatmap,
  useAdminGatewayHistory,
  useAdminLiveKitHistory,
  useAdminLiveKitUsage,
  useAdminTopServers,
} from "@spook/shared";
import { useState } from "react";
import { type BarItem, BarList, Gauge, Heatmap, TimeSeriesChart } from "@/components/charts";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatBitrate, formatDecimal, formatNumber } from "@/features/admin/format";
import { Facts, Section } from "@/features/admin/ui";
import { formatBytes } from "@/lib/file-size";

const HISTORY_MS = 60_000;
const ACTIVITY_MS = 10 * 60_000;

const RANGES: { value: AdminLiveKitHistoryRange; label: string; hint: string }[] = [
  { value: "24h", label: "24 h", hint: "Pontos de 5 minutos" },
  { value: "7d", label: "7 dias", hint: "Pontos de 1 hora" },
  { value: "30d", label: "30 dias", hint: "Pontos de 1 dia" },
];

const pad = (n: number) => String(n).padStart(2, "0");

/** Rótulo curto de um ponto: hora (24 h), dia e hora (7 dias) ou dia (30 dias), sempre em UTC como o servidor. */
export function pointLabel(iso: string, range: AdminLiveKitHistoryRange): string {
  const d = new Date(iso);
  const day = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}`;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  if (range === "24h") return time;
  if (range === "7d") return `${day} ${pad(d.getUTCHours())} h`;
  return day;
}

const COLLECTING = "Coletando dados… O histórico começa a aparecer em alguns minutos.";

/** Histórico persistido do LiveKit (participantes e tráfego) e do gateway, com seletor de janela. */
export function HistorySection() {
  const [range, setRange] = useState<AdminLiveKitHistoryRange>("24h");
  const history = useAdminLiveKitHistory(
    { range },
    { query: { refetchInterval: HISTORY_MS, staleTime: 0 } },
  );
  const gateway = useAdminGatewayHistory({ query: { refetchInterval: HISTORY_MS, staleTime: 0 } });
  const h = history.data;
  const points = (h?.points ?? []).filter((p) => p.has_media);
  const collecting = !history.isPending && (h?.collecting === true || points.length === 0);
  const hint = RANGES.find((r) => r.value === range)?.hint;
  const gwPoints = gateway.data?.points ?? [];
  const gwCollecting =
    !gateway.isPending && (gateway.data?.collecting === true || gwPoints.length < 2);

  return (
    <div className="flex flex-col gap-4">
      <Tabs value={range} onValueChange={(v) => setRange(v as AdminLiveKitHistoryRange)}>
        <TabsList aria-label="Janela do histórico">
          {RANGES.map((r) => (
            <TabsTrigger key={r.value} value={r.value}>
              {r.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <div className="grid gap-4 lg:grid-cols-2">
        <Section
          className="min-w-0"
          title="Participantes em chamadas"
          hint={`Máximo por ponto · ${hint}`}
        >
          <TimeSeriesChart
            title="Participantes em chamadas"
            caption={`Participantes em chamadas (${range}, UTC)`}
            loading={history.isPending}
            points={points.map((p) => ({
              key: p.ts,
              label: pointLabel(p.ts, range),
              value: p.participants,
            }))}
            seriesLabel="Participantes"
            emptyText={collecting ? COLLECTING : "Sem dados no período."}
            formatValue={formatNumber}
          />
        </Section>
        <Section
          className="min-w-0"
          title="Tráfego de saída do LiveKit"
          hint={`Média por ponto · ${hint}`}
        >
          <TimeSeriesChart
            title="Tráfego de saída do LiveKit"
            caption={`Tráfego de saída do LiveKit (${range}, UTC)`}
            loading={history.isPending}
            points={points.map((p) => ({
              key: p.ts,
              label: pointLabel(p.ts, range),
              value: p.bytes_out_per_sec,
            }))}
            seriesLabel="Saída"
            emptyText={collecting ? COLLECTING : "Sem dados no período."}
            formatValue={formatBitrate}
          />
        </Section>
        <Section
          className="min-w-0"
          title="Pessoas online no gateway"
          hint="Últimas 24 h · máximo por ponto de 5 min"
        >
          <TimeSeriesChart
            title="Pessoas online no gateway"
            caption="Pessoas online no gateway (24 h, UTC)"
            loading={gateway.isPending}
            points={gwPoints.map((p) => ({
              key: p.ts,
              label: pointLabel(p.ts, "24h"),
              value: p.online_users,
            }))}
            seriesLabel="Pessoas online"
            emptyText={gwCollecting ? COLLECTING : "Sem dados no período."}
            formatValue={formatNumber}
          />
        </Section>
        <Section
          className="min-w-0"
          title="Conexões WebSocket"
          hint="Últimas 24 h · máximo por ponto de 5 min"
        >
          <TimeSeriesChart
            title="Conexões WebSocket"
            caption="Conexões WebSocket (24 h, UTC)"
            loading={gateway.isPending}
            points={gwPoints.map((p) => ({
              key: p.ts,
              label: pointLabel(p.ts, "24h"),
              value: p.connections,
            }))}
            seriesLabel="Conexões"
            emptyText={gwCollecting ? COLLECTING : "Sem dados no período."}
            formatValue={formatNumber}
          />
        </Section>
      </div>
    </div>
  );
}

/** Mapa de calor de mensagens por hora e dia da semana e o ranking de servidores. */
export function ActivitySection() {
  const heat = useAdminActivityHeatmap({ query: { refetchInterval: ACTIVITY_MS, staleTime: 0 } });
  const top = useAdminTopServers({ query: { refetchInterval: ACTIVITY_MS, staleTime: 0 } });
  const cells = (heat.data?.cells ?? []).map((row) => row ?? []);
  const bars: BarItem[] = (top.data?.items ?? []).map((s) => ({
    key: s.id,
    label: s.name,
    value: s.messages,
    display: formatNumber(s.messages),
    detail: `${formatNumber(s.members)} ${s.members === 1 ? "membro" : "membros"}`,
  }));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Section
        className="min-w-0"
        title="Mensagens por hora e dia da semana"
        hint={`Últimos ${heat.data?.days ?? 28} dias, em UTC · atualiza a cada 10 min`}
      >
        <Heatmap
          title="Mensagens por hora e dia da semana"
          cells={cells}
          loading={heat.isPending}
        />
      </Section>
      <Section
        className="min-w-0"
        title="Servidores mais ativos"
        hint="Mensagens nos últimos 7 dias"
      >
        <BarList
          title="Servidores com mais mensagens em 7 dias"
          items={bars}
          valueHeader="Mensagens"
          loading={top.isPending}
          emptyText="Nenhuma mensagem em servidores nos últimos 7 dias."
        />
      </Section>
    </div>
  );
}

/** Pico de saída em 24 h e tráfego do mês contra o limite do plano (medidor). */
export function PlanUsage() {
  const usage = useAdminLiveKitUsage({ query: { refetchInterval: HISTORY_MS, staleTime: 0 } });
  const u = usage.data;
  if (!u) return <p className="text-sm text-muted-foreground">Carregando o uso do plano…</p>;
  const limit = u.monthly_limit_bytes;
  return (
    <div className="flex flex-col gap-4">
      {limit && u.month_pct !== null ? (
        <Gauge
          label="Tráfego do mês (plano do LiveKit)"
          value={u.month_pct}
          max={100}
          warnAt={70}
          badAt={90}
          format={(n) => `${formatDecimal(n)}%`}
          hint={`${formatBytes(u.month_bytes_out)} de ${formatBytes(limit)} de saída`}
        />
      ) : null}
      <Facts
        items={[
          [
            "Tráfego de saída no mês",
            u.collecting ? "Coletando dados…" : formatBytes(u.month_bytes_out),
          ],
          [
            "Tráfego de entrada no mês",
            u.collecting ? "Coletando dados…" : formatBytes(u.month_bytes_in),
          ],
          [
            "Pico de saída em 24 h",
            u.collecting ? "Coletando dados…" : formatBitrate(u.peak_out_24h_per_sec),
          ],
          ["Limite mensal do plano", limit ? formatBytes(limit) : "não configurado"],
        ]}
      />
      {limit ? null : (
        <p className="text-xs text-muted-foreground">
          Defina LIVEKIT_MONTHLY_TRAFFIC_GB no backend para ver o uso contra o limite do plano.
        </p>
      )}
    </div>
  );
}
