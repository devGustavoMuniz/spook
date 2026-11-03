import { useGetUserRelationship } from "@spook/shared";
import { Ban, Check, MessageCircle, Phone, Send, UserMinus, UserPlus, X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useT } from "@/i18n";
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
  const { t } = useT();
  const rel = useGetUserRelationship(userId, { query: { staleTime: 15_000 } });
  const actions = useSocialActions();
  const dms = useDmActions();
  const [confirm, setConfirm] = useState<SocialConfirm | null>(null);
  const [inviting, setInviting] = useState(false);
  const type = rel.data?.type;
  const busy = actions.pending !== null;

  async function confirmed(c: SocialConfirm) {
    setConfirm(null);
    if (c.kind === "remove")
      await actions.remove(c.userId, t("people.person.removedFriend", { name: c.name }));
    else if (await actions.block(c.userId, t("people.person.blocked", { name: c.name }))) onClose();
  }

  if (rel.isError)
    return (
      <p role="alert" className="text-sm text-destructive-text">
        {appMessage(rel.error)}{" "}
        <button type="button" className="underline" onClick={() => void rel.refetch()}>
          {t("people.common.retry")}
        </button>
      </p>
    );
  if (rel.isPending)
    return (
      <div aria-busy className="flex flex-col gap-2">
        <span className="sr-only">{t("people.person.loading")}</span>
        <div className="h-9 animate-pulse rounded-md bg-muted" />
      </div>
    );

  return (
    <div className="flex flex-col gap-2">
      {type === "blocked" ? (
        <>
          <p className="text-sm text-muted-foreground">{t("people.person.youBlocked", { name })}</p>
          <Button
            variant="outline"
            loading={actions.pending === `unblock:${userId}`}
            onClick={() => void actions.unblock(userId, t("people.person.unblocked", { name }))}
          >
            {t("people.person.unblock")}
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
              <MessageCircle /> {t("people.members.sendMessage")}
            </Button>
            <Button
              variant="outline"
              aria-label={t("people.person.callAria", { name })}
              disabled={dms.pending}
              onClick={() => {
                onClose();
                void dms.call(userId);
              }}
            >
              <Phone /> {t("people.person.call")}
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
                <UserPlus /> {t("people.person.addFriend")}
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
                  <Check /> {t("people.person.acceptRequest")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void actions.remove(userId)}
                >
                  <X /> {t("people.person.decline")}
                </Button>
              </>
            ) : null}
            {type === "outgoing" ? (
              <Button
                variant="secondary"
                size="sm"
                disabled={busy}
                onClick={() => void actions.remove(userId, t("people.person.requestCanceled"))}
              >
                <X /> {t("people.person.cancelRequest")}
              </Button>
            ) : null}
            {type === "friend" ? (
              <>
                <Button variant="secondary" size="sm" onClick={() => setInviting(true)}>
                  <Send /> {t("people.person.inviteToServer")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-destructive-text hover:bg-danger-soft"
                  onClick={() => setConfirm({ kind: "remove", userId, name })}
                >
                  <UserMinus /> {t("people.person.removeFriend")}
                </Button>
              </>
            ) : null}
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive-text hover:bg-danger-soft"
              onClick={() => setConfirm({ kind: "block", userId, name })}
            >
              <Ban /> {t("people.person.block")}
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
