import { ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import {
  type AppAudioPrefs,
  buildRows,
  clampPercent,
  saveAppAudioPrefs,
  selectedCount,
} from "./app-audio";
import { listAudioApps } from "./controller";
import type { AppAudioMode, AudioAppsResult } from "./engine";

/** A lista de aplicativos com som é refeita a cada 3 s enquanto a seção está aberta e o modo é "selecionados". */
export const APP_LIST_POLL_MS = 3000;

type Listing =
  | { status: "loading"; result?: AudioAppsResult }
  | { status: "ready"; result: AudioAppsResult }
  | { status: "error"; result?: AudioAppsResult };

/**
 * Consulta a engine ao montar (descobre se há suporte e quais aplicativos tocam) e, com `poll`, repete a cada
 * `APP_LIST_POLL_MS`; `refresh` força uma consulta. A repetição para sozinha se a plataforma não tem suporte.
 */
function useAudioApps(poll: boolean) {
  const [listing, setListing] = useState<Listing>({ status: "loading" });
  const [tick, setTick] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `tick` só existe para o botão "Atualizar" refazer o efeito
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const run = async () => {
      try {
        const result = await listAudioApps();
        if (!alive) return;
        setListing({ status: "ready", result });
        if (!result.supported && timer) clearInterval(timer);
      } catch {
        if (alive) setListing((prev) => ({ status: "error", result: prev.result }));
      }
    };
    void run();
    if (poll) timer = setInterval(() => void run(), APP_LIST_POLL_MS);
    return () => {
      alive = false;
      if (timer) clearInterval(timer);
    };
  }, [poll, tick]);
  return { listing, refresh: useCallback(() => setTick((n) => n + 1), []) };
}

/**
 * "Configurações avançadas" do compartilhamento de tela (só no desktop): "Áudio de aplicativos". Recolhida por
 * padrão (é uma opção de nicho). Interruptor, modo (todo o sistema ou aplicativos selecionados) e, no segundo,
 * volume master e a lista de aplicativos com som (caixa de seleção + volume de cada um). O Spook nunca aparece.
 */
export function ScreenShareAppAudio({
  audio,
  onAudioChange,
  prefs,
  onPrefsChange,
  onSupportChange,
}: {
  audio: boolean;
  onAudioChange: (on: boolean) => void;
  prefs: AppAudioPrefs;
  onPrefsChange: (next: AppAudioPrefs) => void;
  /** O motor não captura áudio por aplicativo neste computador (o diálogo confirma sem áudio). */
  onSupportChange: (supported: boolean) => void;
}) {
  const { t } = useT();
  const uid = useId();
  const [open, setOpen] = useState(false);
  // Uma consulta ao montar (descobre se há suporte); a repetição só com a lista visível.
  const { listing, refresh } = useAudioApps(open && audio && prefs.mode === "apps");
  const result = listing.result;
  const unsupported = result?.supported === false;
  const showList = audio && prefs.mode === "apps" && !unsupported;

  useEffect(() => {
    onSupportChange(!unsupported);
  }, [unsupported, onSupportChange]);

  const update = (next: AppAudioPrefs) => {
    saveAppAudioPrefs(next);
    onPrefsChange(next);
  };
  const setMode = (mode: AppAudioMode) => update({ ...prefs, mode });
  const patchApp = (exe: string, patch: { selected?: boolean; volume?: number }) =>
    update({
      ...prefs,
      apps: {
        ...prefs.apps,
        [exe]: { ...(prefs.apps[exe] ?? { selected: false, volume: 100 }), ...patch },
      },
    });

  const rows = buildRows(result?.apps ?? [], prefs);
  const reason = result?.reason ?? "platform";
  const panelId = `${uid}-panel`;

  return (
    <section aria-labelledby={`${uid}-title`} className="flex flex-col gap-3">
      <h3 id={`${uid}-title`} className="text-sm font-medium">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("voice.appAudio.advanced")}
          <ChevronDown
            className={cn("size-4 transition-transform", open && "rotate-180")}
            aria-hidden
          />
        </button>
      </h3>
      {open ? (
        <div id={panelId} className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor={`${uid}-audio`} className="flex min-w-0 flex-col text-sm">
              <span>{t("voice.appAudio.title")}</span>
              <span className="text-xs text-muted-foreground">{t("voice.appAudio.hint")}</span>
            </label>
            <Switch
              id={`${uid}-audio`}
              checked={audio && !unsupported}
              disabled={unsupported}
              onCheckedChange={onAudioChange}
            />
          </div>
          {unsupported ? (
            <output className="block rounded-md border border-destructive/40 px-3 py-2 text-xs">
              {t(`voice.appAudio.unsupported.${reason}`)}
            </output>
          ) : null}
          {audio && !unsupported ? (
            <div className="flex flex-col gap-1.5">
              <span id={`${uid}-mode`} className="text-sm font-medium">
                {t("voice.appAudio.mode")}
              </span>
              <div
                role="radiogroup"
                aria-labelledby={`${uid}-mode`}
                className="grid auto-cols-fr grid-flow-col gap-1 rounded-lg border border-border bg-surface-1 p-1"
              >
                {(["system", "apps"] as const).map((m) => (
                  <label
                    key={m}
                    className={cn(
                      "flex min-h-9 cursor-pointer items-center justify-center rounded-md px-3 py-1 text-center text-sm font-medium transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                      prefs.mode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${uid}-mode`}
                      value={m}
                      checked={prefs.mode === m}
                      onChange={() => setMode(m)}
                      className="sr-only"
                    />
                    {t(m === "system" ? "voice.appAudio.modeSystem" : "voice.appAudio.modeApps")}
                  </label>
                ))}
              </div>
              {prefs.mode === "system" ? (
                <p className="text-xs text-muted-foreground">{t("voice.appAudio.systemHint")}</p>
              ) : null}
            </div>
          ) : null}
          {showList ? (
            <div className="flex flex-col gap-2">
              <VolumeRow
                id={`${uid}-master`}
                label={t("voice.appAudio.master")}
                value={prefs.master}
                onChange={(v) => update({ ...prefs, master: v })}
                strong
              />
              <ul
                aria-label={t("voice.appAudio.list")}
                className="flex max-h-52 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1"
              >
                {rows.length === 0 ? (
                  <li className="px-2 py-3 text-center text-xs text-muted-foreground">
                    {listing.status === "loading"
                      ? t("voice.appAudio.loading")
                      : listing.status === "error"
                        ? t("voice.appAudio.error")
                        : t("voice.appAudio.empty")}
                  </li>
                ) : (
                  rows.map((r) => {
                    const state = prefs.apps[r.exe] ?? { selected: false, volume: 100 };
                    return (
                      <li key={r.exe} className="flex flex-col gap-1 rounded-md px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <input
                            id={`${uid}-app-${r.exe}`}
                            type="checkbox"
                            className="size-4 shrink-0 accent-primary"
                            checked={state.selected}
                            onChange={(e) => patchApp(r.exe, { selected: e.target.checked })}
                          />
                          {r.icon ? <img src={r.icon} alt="" className="size-5 shrink-0" /> : null}
                          <label
                            htmlFor={`${uid}-app-${r.exe}`}
                            className="min-w-0 flex-1 truncate text-sm"
                          >
                            {r.name}
                          </label>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {r.present
                              ? r.playing
                                ? t("voice.appAudio.playing")
                                : null
                              : t("voice.appAudio.notOpen")}
                          </span>
                        </div>
                        <VolumeRow
                          id={`${uid}-vol-${r.exe}`}
                          label={t("voice.appAudio.volumeOf", { name: r.name })}
                          value={state.volume}
                          onChange={(v) => patchApp(r.exe, { volume: v })}
                          hideLabel
                        />
                      </li>
                    );
                  })
                )}
              </ul>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {selectedCount(prefs) === 0
                    ? t("voice.appAudio.noneSelected")
                    : t("voice.appAudio.selfExcluded")}
                </p>
                <Button type="button" variant="ghost" size="sm" onClick={refresh}>
                  <RefreshCw aria-hidden />
                  {t("voice.appAudio.refresh")}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Controle de volume 0 a 100 com o valor em texto. `hideLabel`: o rótulo só para leitores de tela. */
function VolumeRow({
  id,
  label,
  value,
  onChange,
  strong,
  hideLabel,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (v: number) => void;
  strong?: boolean;
  hideLabel?: boolean;
}) {
  const { t } = useT();
  return (
    <div className="flex items-center gap-3">
      <label
        htmlFor={id}
        className={cn("shrink-0 text-sm", strong && "font-medium", hideLabel && "sr-only")}
      >
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        aria-valuetext={t("voice.appAudio.percent", { value })}
        onChange={(e) => onChange(clampPercent(Number(e.target.value)))}
        className="min-w-0 flex-1 accent-primary"
      />
      <span aria-hidden className="w-10 shrink-0 text-right text-xs tabular-nums">
        {t("voice.appAudio.percent", { value })}
      </span>
    </div>
  );
}
