import { useGetMe, type VoiceStatePayload } from "@spook/shared";
import { HeadphoneOff, MicOff, MonitorUp, MoreHorizontal, ShieldOff, Video } from "lucide-react";
import { useState } from "react";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { useVoiceModeration, VoiceModerationItems } from "./moderation";
import { PersonVolumeButton, PersonVolumePanel } from "./person-volume";
import { StreamCard, type WatchAction } from "./stream-card";
import type { PersonLookup } from "./use-person-lookup";

/** Ícones de estado de um participante (mudo, surdo, câmera, tela), com texto para leitores de tela. */
export function VoiceFlags({
  state,
  className,
  hideScreen,
}: {
  state: VoiceStatePayload;
  className?: string;
  /** O ícone de tela já aparece em outro lugar (o cartão da transmissão). */
  hideScreen?: boolean;
}) {
  const icon = "size-3.5 shrink-0";
  return (
    <span className={cn("flex items-center gap-1 text-muted-foreground", className)}>
      {state.self_screen && !hideScreen ? (
        <MonitorUp
          className={cn(icon, "text-primary")}
          role="img"
          aria-label="Compartilhando a tela"
        />
      ) : null}
      {state.self_video ? (
        <Video className={cn(icon, "text-primary")} role="img" aria-label="Câmera ligada" />
      ) : null}
      {state.server_muted ? (
        <ShieldOff
          className={cn(icon, "text-destructive-text")}
          role="img"
          aria-label="Mutado pelo servidor"
        />
      ) : null}
      {state.self_deaf ? (
        <HeadphoneOff
          className={cn(icon, "text-destructive-text")}
          role="img"
          aria-label="Áudio desativado"
        />
      ) : state.self_mute && !state.server_muted ? (
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
  watch,
  className,
}: {
  participants: VoiceStatePayload[];
  lookup: PersonLookup;
  speaking?: ReadonlySet<string>;
  size?: number;
  /** Habilita o cartão "Assistir transmissão" em quem está compartilhando a tela. */
  watch?: WatchAction;
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
        const streaming = !!watch && p.self_screen && !!me && p.user_id !== me.id;
        const nameEl = (
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              talking ? "font-medium text-foreground" : "group-hover:text-foreground",
            )}
          >
            {person.name}
            {talking ? <span className="sr-only"> (falando)</span> : null}
          </span>
        );
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
              {streaming && watch ? (
                <StreamCard state={p} name={person.name} watch={watch}>
                  {nameEl}
                </StreamCard>
              ) : (
                nameEl
              )}
              <VoiceFlags state={p} hideScreen={streaming} />
              <ParticipantModeration state={p} name={person.name} />
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

/** Menu "⋯" do participante com as ações de moderação de voz; só existe para quem tem permissão sobre ele. */
function ParticipantModeration({ state, name }: { state: VoiceStatePayload; name: string }) {
  const mod = useVoiceModeration(state);
  if (!mod.any) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className="size-6 shrink-0 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
          aria-label={`Moderar ${name} na voz`}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <VoiceModerationItems state={state} name={name} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
