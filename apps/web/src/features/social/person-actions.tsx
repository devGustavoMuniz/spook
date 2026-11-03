import { useGetUserRelationship } from "@spook/shared";
import { Ban, Check, MessageCircle, Phone, Send, UserMinus, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { appMessage } from "@/lib/app-errors";
import { type SocialConfirm, SocialConfirmDialog } from "./confirm";
import { useDmActions } from "./dm-actions";
import { useSocialActions } from "./hooks";
import { InviteToServerDialog } from "./invite-dialog";

/**
 * Ações do cartão de perfil conforme o relacionamento (um único GET `/users/{id}/relationship`, sem N+1):
 * enviar mensagem, ligar, adicionar/aceitar/recusar/cancelar/remover amigo, convidar para servidor e bloquear/desbloquear.
 * Quem você bloqueou não recebe mensagem nem ligação; as ações de amizade somem.
 */
export function PersonActions({
  userId,
  username,
  name,
  onClose,
}: {
  userId: string;
  username: string;
  name: string;
  onClose: () => void;
}) {
  const rel = useGetUserRelationship(userId, { query: { staleTime: 15_000 } });
  const actions = useSocialActions();
  const dms = useDmActions();
  const [confirm, setConfirm] = useState<SocialConfirm | null>(null);
  const [inviting, setInviting] = useState(false);
  const type = rel.data?.type;
  const busy = actions.pending !== null;

  async function confirmed(c: SocialConfirm) {
    setConfirm(null);
    if (c.kind === "remove") await actions.remove(c.userId, `${c.name} foi removido dos amigos.`);
    else if (await actions.block(c.userId, `${c.name} foi bloqueado.`)) onClose();
  }

  if (rel.isError)
    return (
      <p role="alert" className="text-sm text-destructive-text">
        {appMessage(rel.error)}{" "}
        <button type="button" className="underline" onClick={() => void rel.refetch()}>
          Tentar de novo
        </button>
      </p>
    );
  if (rel.isPending)
    return (
      <div aria-busy className="flex flex-col gap-2">
        <span className="sr-only">Carregando relacionamento…</span>
        <div className="h-9 animate-pulse rounded-md bg-muted" />
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {type === "blocked" ? (
        <>
          <p className="text-sm text-muted-foreground">
            Você bloqueou {name}. Ele não pode te chamar nem você a ele.
          </p>
          <Button
            variant="outline"
            loading={actions.pending === `unblock:${userId}`}
            onClick={() => void actions.unblock(userId, `${name} foi desbloqueado.`)}
          >
            Desbloquear
          </Button>
        </>
      ) : (
        <>
          <div className="flex gap-2">
            <Button
              className="flex-1"
              disabled={dms.pending}
              onClick={() => {
                onClose();
                void dms.message(userId);
              }}
            >
              <MessageCircle /> Enviar mensagem
            </Button>
            <Button
              variant="outline"
              aria-label={`Ligar para ${name}`}
              disabled={dms.pending}
              onClick={() => {
                onClose();
                void dms.call(userId);
              }}
            >
              <Phone /> Ligar
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {type === "none" ? (
              <Button
                variant="secondary"
                size="sm"
                loading={actions.pending === "request"}
                disabled={busy}
                onClick={() => void actions.request(username)}
              >
                <UserPlus /> Adicionar amigo
              </Button>
            ) : null}
            {type === "incoming" ? (
              <>
                <Button
                  size="sm"
                  loading={actions.pending === `accept:${userId}`}
                  disabled={busy}
                  onClick={() => void actions.accept(userId)}
                >
                  <Check /> Aceitar pedido
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void actions.remove(userId)}
                >
                  <X /> Recusar
                </Button>
              </>
            ) : null}
            {type === "outgoing" ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void actions.remove(userId, "Pedido cancelado.")}
              >
                <X /> Cancelar pedido
              </Button>
            ) : null}
            {type === "friend" ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => setInviting(true)}>
                  <Send /> Convidar para servidor
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive-text hover:bg-danger-soft"
                  onClick={() => setConfirm({ kind: "remove", userId, name })}
                >
                  <UserMinus /> Remover amigo
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive-text hover:bg-danger-soft"
              onClick={() => setConfirm({ kind: "block", userId, name })}
            >
              <Ban /> Bloquear
            </Button>
          </div>
        </>
      )}
      <SocialConfirmDialog
        confirm={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={(c) => void confirmed(c)}
      />
      <InviteToServerDialog
        friend={inviting ? { id: userId, name } : null}
        onClose={() => setInviting(false)}
      />
    </div>
  );
}
