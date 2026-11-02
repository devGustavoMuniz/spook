import { useGetMe, type VoiceStatePayload } from "@spook/shared";
import { HeadphoneOff, MicOff, MonitorUp, Video } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { cn } from "@/lib/utils";
import { PersonVolumeButton, PersonVolumePanel } from "./person-volume";
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
  size = 24,
  className,
}: {
  participants: VoiceStatePayload[];
  lookup: PersonLookup;
  speaking?: ReadonlySet<string>;
  size?: number;
  className?: string;
}) {
  const { data: me } = useGetMe();
  const [volumeFor, setVolumeFor] = useState<string | null>(null);
  if (participants.length === 0) return null;
  // Volume por pessoa só vale para quem está na MESMA chamada que eu (`speaking` só vem para a minha chamada).
  const inMyCall = speaking !== undefined;
  return (
    <ul aria-label="Conectados" className={cn("flex flex-col gap-0.5", className)}>
      {participants.map((p) => {
        const person = lookup(p.user_id);
        const talking = !!speaking?.has(p.user_id);
        const adjustable = inMyCall && !!me && p.user_id !== me.id;
        return (
          <li
            key={p.user_id}
            data-speaking={talking || undefined}
            className="group flex flex-col gap-1 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent"
          >
            <div className="flex items-center gap-2">
              <span className="relative inline-flex shrink-0 rounded-full">
                <Avatar
                  url={person.avatarUrl}
                  name={person.name}
                  size={size}
                  fallback="initials"
                  seed={p.user_id}
                />
                {talking ? (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute -inset-0.5 animate-speaking rounded-full border-2 border-speaking"
                  />
                ) : null}
              </span>
              <span
                className={cn(
                  "min-w-0 flex-1 truncate",
                  talking ? "font-medium text-foreground" : "group-hover:text-foreground",
                )}
              >
                {person.name}
                {talking ? <span className="sr-only"> (falando)</span> : null}
              </span>
              <VoiceFlags state={p} />
              {adjustable ? (
                <PersonVolumeButton
                  userId={p.user_id}
                  name={person.name}
                  open={volumeFor === p.user_id}
                  onToggle={() => setVolumeFor((cur) => (cur === p.user_id ? null : p.user_id))}
                />
              ) : null}
            </div>
            {adjustable && volumeFor === p.user_id ? (
              <PersonVolumePanel
                userId={p.user_id}
                name={person.name}
                onClose={() => setVolumeFor(null)}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
