import { Ban } from "lucide-react";
import { ErrorState } from "@/components/state-screen";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { shownName } from "@/features/account/removed-user";
import { SettingsGroup } from "@/features/settings/ui";
import { useAllRelationships, useSocialActions } from "@/features/social/hooks";

/** Configurações > Bloqueados: quem você bloqueou, com "Desbloquear". */
export function BlockedPage() {
  const rels = useAllRelationships();
  const actions = useSocialActions();
  const blocked = (rels.data ?? []).filter((r) => r.type === "blocked");
  return (
    <SettingsGroup
      icon={Ban}
      title="Pessoas bloqueadas"
      description="Quem você bloqueia não pode iniciar conversas privadas nem ligar para você (e você, para ela). Suas mensagens ficam recolhidas, as menções dela não geram aviso e a pessoa não é avisada."
    >
      {rels.isPending ? (
        <Skeleton className="h-10 w-full" />
      ) : rels.isError ? (
        <ErrorState
          error={rels.error}
          onRetry={() => void rels.refetch()}
          retrying={rels.isFetching}
        />
      ) : blocked.length === 0 ? (
        <p className="text-sm text-muted-foreground">Você não bloqueou ninguém.</p>
      ) : (
        <ul aria-label="Pessoas bloqueadas" className="flex flex-col gap-1">
          {blocked.map((r) => {
            const name = shownName(r.user.display_name, r.user.username);
            return (
              <li key={r.user.id} className="flex items-center gap-3 py-1.5">
                <Avatar url={r.user.avatar_url} name={name} seed={r.user.id} size={36} />
                <div className="flex min-w-0 flex-1 flex-col leading-tight">
                  <span className="truncate text-sm font-medium">{name}</span>
                  <span className="truncate text-xs text-muted-foreground">@{r.user.username}</span>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  loading={actions.pending === `unblock:${r.user.id}`}
                  onClick={() => void actions.unblock(r.user.id, `${name} foi desbloqueado.`)}
                >
                  Desbloquear
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroup>
  );
}
