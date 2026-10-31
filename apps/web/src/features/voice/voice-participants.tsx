import type { VoiceStatePayload } from "@spook/shared";
import { HeadphoneOff, MicOff, MonitorUp, Video } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { cn } from "@/lib/utils";
import type { PersonLookup } from "./use-person-lookup";

/** Ícones de estado de um participante (mudo, surdo, câmera, tela), com texto para leitores de tela. */
export function VoiceFlags({ state, className }: { state: VoiceStatePayload; className?: string }) {
  const icon = "size-3.5 shrink-0";
  return (
    <span className={cn("flex items-center gap-1 text-muted-foreground", className)}>
      {state.self_screen ? (
        <MonitorUp
          className={cn(icon, "text-primary")}
          role="img"
          aria-label="Compartilhando a tela"
        />
      ) : null}
      {state.self_video ? (
        <Video className={cn(icon, "text-primary")} role="img" aria-label="Câmera ligada" />
      ) : null}
      {state.self_deaf ? (
        <HeadphoneOff
          className={cn(icon, "text-destructive-text")}
          role="img"
          aria-label="Áudio desativado"
        />
      ) : state.self_mute ? (
        <MicOff
          className={cn(icon, "text-destructive-text")}
          role="img"
          aria-label="Microfone silenciado"
        />
      ) : null}
    </span>
  );
}

/** Lista de quem está conectado a um canal de voz (avatar, nome, estado, destaque de quem fala). */
export function VoiceParticipants({
  participants,
  lookup,
  speaking,
  size = 20,
  className,
}: {
  participants: VoiceStatePayload[];
  lookup: PersonLookup;
  speaking?: ReadonlySet<string>;
  size?: number;
  className?: string;
}) {
  if (participants.length === 0) return null;
  return (
    <ul aria-label="Conectados" className={cn("flex flex-col gap-0.5", className)}>
      {participants.map((p) => {
        const person = lookup(p.user_id);
        const talking = !!speaking?.has(p.user_id);
        return (
          <li
            key={p.user_id}
            data-speaking={talking || undefined}
            className="flex items-center gap-2 rounded-md px-2 py-1 text-sm text-muted-foreground"
          >
            <span
              className={cn(
                "inline-flex rounded-full ring-2 ring-transparent transition-shadow",
                talking && "ring-emerald-500",
              )}
            >
              <Avatar url={person.avatarUrl} name={person.name} size={size} />
            </span>
            <span className={cn("min-w-0 flex-1 truncate", talking && "text-foreground")}>
              {person.name}
              {talking ? <span className="sr-only"> (falando)</span> : null}
            </span>
            <VoiceFlags state={p} />
          </li>
        );
      })}
    </ul>
  );
}
