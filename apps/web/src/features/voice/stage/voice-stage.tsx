import { useGetMe, type VoiceStatePayload } from "@spook/shared";
import { Expand, Minimize, TriangleAlert, Volume2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { Guild } from "@/lib/guild";
import { cn } from "@/lib/utils";
import {
  clearFocusRequest,
  resumeAudio,
  screenSourceSwapSupported,
  screenWatchSupported,
  setScreenWatching,
  swapScreenSource,
  toggleCamera,
  toggleMute,
} from "../controller";
import { voicePermissions } from "../permissions";
import { useStageMountedStore, useVoiceStore } from "../store";
import type { PersonLookup } from "../use-person-lookup";
import { pickAutoFocus, useCallLayoutStore, visibleTiles } from "./call-layout";
import { ControlBar } from "./control-bar";
import { InviteTile } from "./invite-tile";
import { bestGrid } from "./layout";
import { ParticipantTile, type TileModel } from "./participant-tile";
import { StageHoldContext, useAutoHide } from "./use-auto-hide";

const GAP = 12;
/** Por quanto tempo "Assistir transmissão" espera a tela chegar antes de desistir. */
export const FOCUS_REQUEST_TTL_MS = 10_000;
const STRIP_TILE = 176;

/** Monta os tiles: um por pessoa (com a câmera dela, se ligada) e um por tela compartilhada. */
export function buildTiles(
  participants: VoiceStatePayload[],
  lookup: PersonLookup,
  tracks: ReturnType<typeof useVoiceStore.getState>["videoTracks"],
  me: { id: string; mine: NonNullable<TileModel["mine"]> } | null,
  /** Engine que escolhe quais telas assinar: telas de outras pessoas sem faixa viram tiles "Assistir". */
  watch: { supported: boolean; swap?: boolean } = { supported: false },
): TileModel[] {
  const out: TileModel[] = [];
  const users = new Set(participants.map((p) => p.user_id));
  const ordered = [...participants];
  // Eu primeiro (o tile de convite fica ao lado do meu).
  ordered.sort((a, b) => Number(b.user_id === me?.id) - Number(a.user_id === me?.id));
  for (const p of ordered) {
    const person = lookup(p.user_id);
    const isMe = p.user_id === me?.id;
    out.push({
      key: `u:${p.user_id}`,
      userId: p.user_id,
      name: person.name,
      avatarUrl: person.avatarUrl,
      kind: "person",
      local: isMe,
      state: p,
      mine: isMe ? me?.mine : undefined,
      video: tracks.find((t) => t.kind === "camera" && t.identity === p.user_id),
    });
  }
  for (const t of tracks) {
    if (t.kind === "camera" && users.has(t.identity)) continue;
    const person = lookup(t.identity);
    out.push({
      key: t.kind === "screen" ? `s:${t.id}` : `u:${t.identity}`,
      userId: t.identity,
      name: person.name,
      avatarUrl: person.avatarUrl,
      kind: t.kind === "screen" ? "screen" : "person",
      local: t.local,
      video: t,
      ...(t.kind === "screen" && !t.local && watch.supported ? { canStopWatching: true } : {}),
      ...(t.kind === "screen" && t.local && watch.swap ? { canSwapSource: true } : {}),
    });
  }
  if (watch.supported && me) {
    // Quem transmite a tela mas eu ainda não assisto: um tile com a prévia e o botão "Assistir".
    for (const p of ordered) {
      if (!p.self_screen || p.user_id === me.id) continue;
      if (tracks.some((t) => t.kind === "screen" && t.identity === p.user_id)) continue;
      const person = lookup(p.user_id);
      out.push({
        key: `s:pending:${p.user_id}`,
        userId: p.user_id,
        name: person.name,
        avatarUrl: person.avatarUrl,
        kind: "screen",
        local: false,
        unwatched: true,
      });
    }
  }
  return out;
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const px = (v: string) => Number.parseFloat(v) || 0;
      setSize({
        width: Math.max(0, el.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight)),
        height: Math.max(0, el.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom)),
      });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  return size;
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el?.closest("input, textarea, select, [contenteditable=true]");
}

/**
 * Palco da chamada: grade responsiva de tiles (avatar grande sobre a cor dominante, câmera, tela), anel
 * verde em quem fala, modo foco (tile grande + tira) e a barra flutuante de controles que some após ociosidade.
 * Sem `inCall` é só uma prévia de quem está conectado (sem controles).
 */
export function VoiceStage({
  participants,
  lookup,
  inCall,
  guild,
  leaveLabel,
  className,
}: {
  participants: VoiceStatePayload[];
  lookup: PersonLookup;
  inCall: boolean;
  /** Servidor da chamada: habilita o tile de convite. Em DM fica `undefined` (sem tile de convite). */
  guild?: Guild;
  leaveLabel?: string;
  className?: string;
}) {
  const { data: me } = useGetMe();
  const status = useVoiceStore((s) => s.status);
  const speaking = useVoiceStore((s) => s.speaking);
  const tracks = useVoiceStore((s) => s.videoTracks);
  const selfMute = useVoiceStore((s) => s.selfMute);
  const selfDeaf = useVoiceStore((s) => s.selfDeaf);
  const camera = useVoiceStore((s) => s.camera);
  const screen = useVoiceStore((s) => s.screen);
  const audioBlocked = useVoiceStore((s) => s.audioBlocked);
  const mediaIssue = useVoiceStore((s) => s.mediaIssue);
  const focusRequest = useVoiceStore((s) => s.focusRequest);
  const channelId = useVoiceStore((s) => s.channelId);
  const layout = useCallLayoutStore((s) => s.layout);
  // As capacidades dependem da engine criada ao entrar na chamada; `tracks` muda a cada entrada/saída de tela.
  // Lidas a cada render (a engine só existe depois de entrar); booleanos, para não refazer os tiles à toa.
  const canWatch = inCall && screenWatchSupported();
  const canSwap = inCall && screenSourceSwapSupported();
  const perms = voicePermissions(guild);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [issueDismissed, setIssueDismissed] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const root = useRef<HTMLElement>(null);
  const area = useRef<HTMLDivElement>(null);
  const size = useElementSize(area);

  const auto = useAutoHide({ forceVisible: status !== "connected" });
  const barVisible = inCall && auto.visible;

  const tiles = useMemo(
    () =>
      buildTiles(
        participants,
        lookup,
        inCall ? tracks : [],
        me
          ? {
              id: me.id,
              mine: {
                mute: selfMute || selfDeaf,
                deaf: selfDeaf,
                camera,
                screen,
                cannotSpeak: inCall && !perms.speak,
              },
            }
          : null,
        { supported: canWatch, swap: canSwap },
      ),
    [
      participants,
      lookup,
      inCall,
      tracks,
      me,
      selfMute,
      selfDeaf,
      camera,
      screen,
      perms.speak,
      canWatch,
      canSwap,
    ],
  );
  const allTiles = tiles;
  const active = inCall && layout === "active" ? visibleTiles(allTiles, speaking) : null;
  const shownTiles = active ? active.shown : allTiles;
  const manualFocus = inCall ? shownTiles.find((t) => t.key === focusedKey && t.video) : undefined;
  const autoFocus =
    inCall && layout === "focus" && !manualFocus && shownTiles.length > 1
      ? pickAutoFocus(shownTiles, speaking)
      : undefined;
  const focused = manualFocus ?? autoFocus;
  // "Assistir transmissão": põe a tela pedida em foco assim que ela chega (a sala ainda pode estar conectando);
  // vence em 10 s, e some se a pessoa parar de transmitir antes.
  useEffect(() => {
    if (!inCall || !focusRequest) return;
    const tile = tiles.find(
      (t) => t.kind === "screen" && t.userId === focusRequest.userId && t.video,
    );
    if (tile) {
      setFocusedKey(tile.key);
      clearFocusRequest(focusRequest.nonce);
      return;
    }
    const left = FOCUS_REQUEST_TTL_MS - (Date.now() - focusRequest.at);
    if (left <= 0) return clearFocusRequest(focusRequest.nonce);
    const timer = setTimeout(() => clearFocusRequest(focusRequest.nonce), left);
    return () => clearTimeout(timer);
  }, [inCall, focusRequest, tiles]);
  // Avisa o cartão da barra lateral que o palco está na tela (ele cuida do "Ativar áudio").
  useEffect(() => {
    if (!inCall) return;
    useStageMountedStore.getState().set(true);
    return () => useStageMountedStore.getState().set(false);
  }, [inCall]);
  const connecting = inCall && status === "connecting";
  const showInvite = inCall && !!guild && participants.length === 1 && !focused;
  const count = shownTiles.length + (showInvite ? 1 : 0);
  const grid = bestGrid(size.width || 1000, size.height || 560, count, GAP);

  // Destacar/voltar remonta o tile noutro lugar: o foco do teclado acompanha o tile.
  const refocus = useRef<string | null>(null);
  const toggleFocus = useCallback((key: string) => {
    refocus.current = key;
    setFocusedKey((cur) => (cur === key ? null : key));
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: roda a cada mudança de foco do layout
  useEffect(() => {
    const key = refocus.current;
    refocus.current = null;
    if (!key) return;
    const tile = [...(root.current?.querySelectorAll<HTMLElement>("[data-tile-key]") ?? [])].find(
      (el) => el.dataset.tileKey === key,
    );
    tile?.querySelector<HTMLElement>("button[data-focus-target]")?.focus();
  }, [focusedKey]);

  const toggleStageFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void root.current?.requestFullscreen?.()?.catch?.(() => {});
  }, []);
  const onFullscreen = useCallback((key: string) => {
    setFocusedKey(key);
    const el = root.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen?.();
    else void el.requestFullscreen?.()?.catch?.(() => {});
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  // Saiu da chamada: sai do foco e da tela cheia.
  useEffect(() => {
    if (inCall) return;
    setFocusedKey(null);
    if (document.fullscreenElement === root.current) void document.exitFullscreen?.();
  }, [inCall]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
    if (e.key === "Escape" && focused && !auto.held) {
      setFocusedKey(null);
      return;
    }
    if (!inCall || status !== "connected") return;
    if (e.key.toLowerCase() === "m" && perms.speak) void toggleMute();
    else if (e.key.toLowerCase() === "v" && perms.video) void toggleCamera();
    else if (e.key.toLowerCase() === "l") useCallLayoutStore.getState().cycle();
    else if (e.key.toLowerCase() === "f") toggleStageFullscreen();
  }

  const speakingNow = (userId: string) => speaking.has(userId);
  const tileFor = (
    t: TileModel,
    opts: { width?: number; large?: boolean; focused?: boolean; className?: string },
  ) => (
    <ParticipantTile
      key={t.key}
      tile={t}
      width={opts.width}
      large={opts.large}
      focused={opts.focused}
      className={opts.className}
      speaking={t.kind === "person" && inCall && speakingNow(t.userId)}
      loading={connecting && t.local}
      interactive={inCall}
      onFocusTile={toggleFocus}
      onFullscreen={onFullscreen}
      onWatch={setScreenWatching}
      onSwapSource={() => void swapScreenSource()}
      channelId={channelId}
    />
  );

  const issue = mediaIssue && mediaIssue !== issueDismissed ? mediaIssue : null;

  return (
    <StageHoldContext.Provider value={auto.hold}>
      <TooltipProvider>
        <section
          ref={root}
          aria-label="Vídeo da chamada"
          data-fullscreen={fullscreen || undefined}
          data-controls={barVisible ? "visible" : "hidden"}
          onKeyDown={onKeyDown}
          {...(inCall ? auto.stageProps : {})}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col overflow-hidden bg-surface-1",
            fullscreen && "bg-background",
            fullscreen && !barVisible && "cursor-none",
            className,
          )}
        >
          {inCall && (status !== "connected" || audioBlocked || issue) ? (
            <div className="pointer-events-none absolute inset-x-3 top-3 z-20 flex flex-col items-center gap-2">
              {status !== "connected" ? (
                <output className="pointer-events-auto flex items-center gap-2 rounded-full border border-border bg-card/90 px-3.5 py-1.5 text-sm font-medium shadow-md backdrop-blur-md">
                  <Spinner />
                  {status === "reconnecting" ? "Reconectando à chamada…" : "Conectando à chamada…"}
                </output>
              ) : null}
              {audioBlocked ? (
                <div className="pointer-events-auto flex items-center gap-3 rounded-xl border border-warning/50 bg-card/95 py-2 pr-2 pl-3.5 text-sm shadow-md backdrop-blur-md">
                  <span>O navegador bloqueou o áudio da chamada.</span>
                  <Button size="sm" onClick={() => void resumeAudio()}>
                    <Volume2 /> Ativar áudio
                  </Button>
                </div>
              ) : null}
              {issue ? (
                <div
                  role="alert"
                  className="pointer-events-auto flex max-w-lg items-start gap-2.5 rounded-xl border border-destructive/50 bg-card/95 py-2.5 pr-2 pl-3.5 text-sm shadow-md backdrop-blur-md"
                >
                  <TriangleAlert
                    className="mt-0.5 size-4 shrink-0 text-destructive-text"
                    aria-hidden
                  />
                  <span className="text-pretty">{issue}</span>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="size-7 shrink-0"
                    aria-label="Dispensar aviso"
                    onClick={() => setIssueDismissed(issue)}
                  >
                    <X />
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}

          <div
            ref={area}
            className={cn(
              "absolute inset-0 overflow-y-auto p-3",
              inCall && "pb-[calc(5.75rem+env(safe-area-inset-bottom))]",
              focused ? "flex flex-col gap-3 overflow-hidden" : "",
            )}
          >
            {focused ? (
              <>
                <ul
                  aria-label="Em destaque"
                  className="flex min-h-0 flex-1 list-none items-stretch justify-center"
                >
                  {tileFor(focused, { large: true, focused: true, className: "min-h-0 flex-1" })}
                </ul>
                {shownTiles.length > 1 ? (
                  <ul
                    aria-label="Participantes da chamada"
                    className="flex shrink-0 list-none gap-2 overflow-x-auto pb-1"
                  >
                    {shownTiles
                      .filter((t) => t !== focused)
                      .map((t) => tileFor(t, { width: STRIP_TILE, className: "shrink-0" }))}
                  </ul>
                ) : null}
              </>
            ) : (
              <ul
                aria-label="Participantes da chamada"
                data-cols={grid.cols}
                className="m-auto flex min-h-full list-none flex-wrap content-center items-center justify-center"
                style={{ gap: GAP }}
              >
                {shownTiles.map((t) => tileFor(t, { width: grid.tileWidth }))}
                {showInvite && guild ? <InviteTile guild={guild} width={grid.tileWidth} /> : null}
              </ul>
            )}
            {active && active.hidden > 0 ? (
              <p
                data-testid="hidden-count"
                className="pointer-events-none absolute top-3 left-3 z-10 rounded-full border border-border bg-card/90 px-3 py-1 text-xs font-medium shadow-sm backdrop-blur-md"
              >
                {active.hidden === 1
                  ? "1 participante oculto"
                  : `${active.hidden} participantes ocultos`}
              </p>
            ) : null}
          </div>

          {inCall ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-30 flex justify-center px-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
              <div
                {...auto.barProps}
                data-testid="stage-controls"
                data-visible={barVisible}
                className={cn(
                  "pointer-events-auto transition-[transform,opacity] duration-[var(--dur-base)] ease-[var(--ease-out)]",
                  barVisible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
                )}
              >
                <ControlBar leaveLabel={leaveLabel} />
              </div>
              <Button
                variant="secondary"
                size="icon-lg"
                aria-label={fullscreen ? "Sair da tela cheia" : "Tela cheia do palco"}
                aria-pressed={fullscreen}
                className={cn(
                  "pointer-events-auto absolute right-4 bottom-[max(1rem,env(safe-area-inset-bottom))] hidden size-11 rounded-full border border-border bg-card/85 shadow-lg backdrop-blur-md transition-[transform,opacity] duration-[var(--dur-base)] sm:inline-flex",
                  barVisible ? "translate-y-0 opacity-100" : "translate-y-3 opacity-0",
                )}
                onClick={toggleStageFullscreen}
              >
                {fullscreen ? <Minimize /> : <Expand />}
              </Button>
            </div>
          ) : null}
        </section>
      </TooltipProvider>
    </StageHoldContext.Provider>
  );
}
