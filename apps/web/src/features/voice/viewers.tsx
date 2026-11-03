import type { VoiceStatePayload } from "@spook/shared";
import { Eye } from "lucide-react";
import { Avatar } from "@/components/ui/avatar";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PersonLookup } from "./use-person-lookup";

/** Avatares mostrados antes do "+N". */
export const VIEWER_AVATARS_SHOWN = 4;

/** Quantas pessoas assistem à tela de quem transmite (0 se não é transmissão ou ninguém assiste). */
export const viewerCountOf = (s: Pick<VoiceStatePayload, "viewer_count"> | undefined) =>
  s?.viewer_count ?? 0;

/**
 * "Assistindo: N" com uma lista curta de avatares (tooltip com o nome de cada um). Quem transmite recebe a lista
 * (`viewers`); os demais só a contagem, e então o selo mostra apenas o número. Não renderiza nada sem espectadores.
 */
export function ViewersBadge({
  state,
  lookup,
  className,
  tone = "default",
}: {
  state: VoiceStatePayload | undefined;
  lookup?: PersonLookup;
  className?: string;
  /** `onVideo`: sobre o vídeo/tile escuro (texto branco); `default`: sobre o fundo do cartão. */
  tone?: "default" | "onVideo";
}) {
  const count = viewerCountOf(state);
  if (!state || count <= 0) return null;
  const ids = state.viewers ?? [];
  const shown = ids.slice(0, VIEWER_AVATARS_SHOWN);
  const rest = Math.max(0, count - shown.length);
  const names = ids.map((id) => lookup?.(id).name ?? "Usuário");
  return (
    <TooltipProvider delayDuration={150}>
      <span
        data-testid="viewers"
        className={cn(
          "inline-flex min-w-0 items-center gap-1.5 text-xs",
          tone === "onVideo" ? "text-white" : "text-muted-foreground",
          className,
        )}
      >
        <Eye className="size-3.5 shrink-0" aria-hidden />
        <span className="tabular shrink-0">Assistindo: {count}</span>
        {names.length > 0 ? <span className="sr-only">: {names.join(", ")}</span> : null}
        {shown.length > 0 ? (
          <ul className="flex shrink-0 items-center -space-x-1.5" aria-label="Quem está assistindo">
            {shown.map((id, i) => (
              <li key={id} className="flex">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className={cn(
                        "inline-flex rounded-full ring-2 outline-none focus-visible:ring-ring",
                        tone === "onVideo" ? "ring-black/60" : "ring-card",
                      )}
                      aria-label={names[i]}
                    >
                      <Avatar
                        url={lookup?.(id).avatarUrl}
                        name={names[i] ?? "Usuário"}
                        size={18}
                        fallback="initials"
                        seed={id}
                      />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>{names[i]}</TooltipContent>
                </Tooltip>
              </li>
            ))}
            {rest > 0 ? (
              <li
                className={cn(
                  "tabular flex size-[18px] items-center justify-center rounded-full bg-muted text-[9px] text-muted-foreground ring-2",
                  tone === "onVideo" ? "ring-black/60" : "ring-card",
                )}
                aria-hidden
              >
                +{rest}
              </li>
            ) : null}
          </ul>
        ) : null}
      </span>
    </TooltipProvider>
  );
}
