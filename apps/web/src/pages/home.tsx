import { useListGuilds } from "@spook/shared";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { AddServerDialog } from "@/features/guilds/add-server-dialog";
import { appMessage } from "@/lib/app-errors";
import { lastLocation } from "@/lib/last-location";

/** `/`: vai ao último servidor visitado (ou ao primeiro); sem servidores, mostra o estado vazio. */
export function HomePage() {
  const guilds = useListGuilds();
  const [dialog, setDialog] = useState<"create" | "join" | null>(null);

  if (guilds.isPending)
    return (
      <output className="block p-6 text-sm text-muted-foreground">
        Carregando seus servidores…
      </output>
    );
  if (guilds.isError)
    return (
      <div className="p-6 text-sm">
        <p className="text-destructive-text">{appMessage(guilds.error)}</p>
        <Button className="mt-3" variant="outline" onClick={() => void guilds.refetch()}>
          Tentar de novo
        </Button>
      </div>
    );

  const list = guilds.data ?? [];
  if (list.length > 0) {
    const target = list.find((g) => g.id === lastLocation.guild()) ?? list[0];
    if (target) return <Navigate to="/channels/$guildId" params={{ guildId: target.id }} replace />;
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-6 text-center">
      <Logo size={96} />
      <div>
        <h1 className="text-xl font-semibold">Você ainda não está em nenhum servidor</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Crie o seu ou entre num servidor com um convite.
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => setDialog("create")}>Criar servidor</Button>
        <Button variant="outline" onClick={() => setDialog("join")}>
          Entrar com convite
        </Button>
      </div>
      <AddServerDialog
        key={dialog ?? "closed"}
        open={dialog !== null}
        initialTab={dialog ?? "create"}
        onOpenChange={(o) => !o && setDialog(null)}
      />
    </div>
  );
}
