import { inviteFriendToGuild, Permission, useListGuilds } from "@spook/shared";
import { Send } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { can } from "@/lib/guild";
import { socialMessage } from "./hooks";

/** "Convidar para servidor": os servidores onde você pode criar convites; o link vai para a DM com o amigo. */
export function InviteToServerDialog({
  friend,
  onClose,
}: {
  friend: { id: string; name: string } | null;
  onClose: () => void;
}) {
  const guilds = useListGuilds();
  const options = (guilds.data ?? []).filter((g) => can(g, Permission.CREATE_INVITE));
  const [busy, setBusy] = useState<string | null>(null);

  async function send(guildId: string, guildName: string) {
    if (!friend) return;
    setBusy(guildId);
    try {
      await inviteFriendToGuild(friend.id, { guild_id: guildId });
      toast.success(`Convite para ${guildName} enviado a ${friend.name}.`);
      onClose();
    } catch (e) {
      toast.error(socialMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Dialog open={!!friend} onOpenChange={(o) => !o && onClose()}>
      <DialogContent flush>
        <DialogHead
          icon={Send}
          title="Convidar para servidor"
          description={
            friend ? `Escolha o servidor; o convite vai na conversa com ${friend.name}.` : undefined
          }
        />
        <DialogBody>
          {guilds.isPending ? (
            <p className="text-sm text-muted-foreground">Carregando seus servidores…</p>
          ) : options.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Você não tem permissão para criar convites em nenhum servidor.
            </p>
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Servidores">
              {options.map((g) => (
                <li key={g.id}>
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void send(g.id, g.name)}
                    className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60"
                  >
                    <Avatar url={g.icon_url} name={g.name} seed={g.id} size={32} />
                    <span className="min-w-0 flex-1 truncate font-medium">{g.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {busy === g.id ? "Enviando…" : "Enviar convite"}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogActions>
          <Button type="button" variant="ghost" onClick={onClose}>
            Fechar
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
