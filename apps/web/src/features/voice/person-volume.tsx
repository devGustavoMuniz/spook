import { Volume2, VolumeX } from "lucide-react";
import { useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { participantVolumeMax, setPersonVolume } from "./controller";
import { personVolumeOf, useParticipantVolumeStore } from "./participant-volume";
import { useVoiceStatesStore, useVoiceStore } from "./store";

/** Botão que abre/fecha o painel de volume de uma pessoa. Some quando a engine não ajusta volume por pessoa. */
export function PersonVolumeButton({
  userId,
  name,
  open,
  onToggle,
  className,
}: {
  userId: string;
  name: string;
  open: boolean;
  onToggle: () => void;
  className?: string;
}) {
  const muted = useParticipantVolumeStore((s) => personVolumeOf(s.byUser, userId).muted);
  if (participantVolumeMax() === null) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className={cn("size-6 shrink-0", className)}
      aria-label={`Volume de ${name}`}
      aria-expanded={open}
      title={`Volume de ${name}`}
      onClick={onToggle}
    >
      {muted ? <VolumeX className="text-destructive-text" /> : <Volume2 />}
    </Button>
  );
}

const pct = (v: number) => Math.round(v * 100);

/** Painel: volume da voz, volume do áudio da tela (se a pessoa compartilha) e "silenciar só para mim". */
export function PersonVolumePanel({
  userId,
  name,
  onClose,
  className,
}: {
  userId: string;
  name: string;
  /** Esc: fecha e devolve o foco ao botão (quem chama decide). */
  onClose: () => void;
  className?: string;
}) {
  const max = participantVolumeMax();
  const v = useParticipantVolumeStore((s) => personVolumeOf(s.byUser, userId));
  const sharing = useVoiceStatesStore((s) => s.byUser[userId]?.self_screen === true);
  const deaf = useVoiceStore((s) => s.selfDeaf);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  if (max === null) return null;

  const slider = (id: string, label: string, value: number, key: "voice" | "screen") => (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="flex justify-between text-xs">
        <span>{label}</span>
        <span>{pct(value)}%</span>
      </label>
      <input
        id={id}
        ref={key === "voice" ? first : undefined}
        type="range"
        min={0}
        max={pct(max)}
        step={1}
        value={pct(Math.min(value, max))}
        aria-valuetext={`${pct(value)} por cento`}
        onChange={(e) => setPersonVolume(userId, { [key]: Number(e.target.value) / 100 })}
        className="accent-primary"
      />
    </div>
  );

  return (
    <fieldset
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "flex flex-col gap-2 rounded-md border bg-popover p-3 text-popover-foreground shadow-md",
        className,
      )}
    >
      <legend className="sr-only">Volume de {name}</legend>
      {slider(`vol-voice-${userId}`, `Volume da voz de ${name}`, v.voice, "voice")}
      {sharing
        ? slider(`vol-screen-${userId}`, `Volume do áudio da tela de ${name}`, v.screen, "screen")
        : null}
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={`vol-mute-${userId}`} className="text-sm">
          Silenciar só para mim
        </label>
        <Switch
          id={`vol-mute-${userId}`}
          checked={v.muted}
          onCheckedChange={(on) => setPersonVolume(userId, { muted: on })}
        />
      </div>
      {deaf ? (
        <p className="text-xs text-muted-foreground">
          Seu áudio está desativado: todos continuam mudos, mesmo com o volume ajustado.
        </p>
      ) : null}
      {max <= 1 ? (
        <p className="text-xs text-muted-foreground">O volume vai até 100% neste navegador.</p>
      ) : null}
    </fieldset>
  );
}
