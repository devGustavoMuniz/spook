import {
  type ChannelPayload,
  useAddDMRecipient,
  useGetMe,
  useRemoveDMRecipient,
  useUpdateChannel,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Crown, LogOut, UserMinus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { StatusAvatar } from "@/components/presence-dot";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useT } from "@/i18n";
import { dmMessage } from "@/lib/app-errors";
import { removeDM, upsertDM } from "@/lib/dm-cache";
import { queryKeys } from "@/lib/queryKeys";
import { isDmOwner, recipientName, recipientsOf } from "./dm-utils";
import { MAX_GROUP_NAME } from "./new-group-dialog";
import { PeoplePicker, useGuildPeople, useSelection } from "./people";

const MAX_PARTICIPANTS = 10;

/** Gestão da DM em grupo: participantes, renomear (dono) e sair. */
export function GroupDialog({
  channel,
  open,
  onOpenChange,
}: {
  channel: ChannelPayload;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: me } = useGetMe();
  const add = useAddDMRecipient();
  const remove = useRemoveDMRecipient();
  const rename = useUpdateChannel();
  const recipients = recipientsOf(channel);
  const owner = !!me && isDmOwner(channel, me.id);
  const inGroup = useMemo(() => new Set(recipients.map((r) => r.id)), [recipients]);
  const { people, pending } = useGuildPeople(inGroup);
  const { selected, toggle, clear } = useSelection();
  const [name, setName] = useState(channel.name);
  const [leaving, setLeaving] = useState(false);
  const free = MAX_PARTICIPANTS - recipients.length;
  const nameChanged = name.trim() !== channel.name && name.trim().length > 0;

  async function saveName() {
    try {
      upsertDM(
        qc,
        await rename.mutateAsync({ channelId: channel.id, data: { name: name.trim() } }),
      );
      toast.success(t("people.group.renamed"));
    } catch (e) {
      toast.error(dmMessage(e, "rename"));
    }
  }

  async function addSelected() {
    const ids = [...selected];
    clear();
    for (const userId of ids) {
      try {
        upsertDM(qc, await add.mutateAsync({ channelId: channel.id, userId }));
      } catch (e) {
        toast.error(dmMessage(e, "add"));
        break;
      }
    }
  }

  async function removeOne(userId: string) {
    try {
      await remove.mutateAsync({ channelId: channel.id, userId });
      upsertDM(qc, { ...channel, recipients: recipients.filter((r) => r.id !== userId) });
    } catch (e) {
      toast.error(dmMessage(e, "remove"));
    }
  }

  async function leave() {
    try {
      await remove.mutateAsync({ channelId: channel.id, userId: "@me" });
      removeDM(qc, channel.id);
      qc.removeQueries({ queryKey: queryKeys.messages(channel.id) });
      onOpenChange(false);
      await navigate({ to: "/channels/@me", replace: true });
    } catch (e) {
      toast.error(dmMessage(e, "leave"));
    } finally {
      setLeaving(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          flush
          className="max-h-[min(40rem,92svh)]"
          // Sem campo de texto com o conteúdo selecionado ao abrir: o foco inicial vai para o próprio diálogo.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (e.currentTarget as HTMLElement).focus();
          }}
        >
          <DialogHead
            icon={Users}
            title={t("people.group.title")}
            description={t(owner ? "people.group.descOwner" : "people.group.descMember", {
              count: recipients.length,
              max: MAX_PARTICIPANTS,
            })}
          />
          <DialogBody className="gap-6">
            {owner ? (
              <form
                className="flex items-end gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (nameChanged) void saveName();
                }}
              >
                <div className="flex flex-1 flex-col gap-1.5">
                  <Label htmlFor="rename-group">{t("people.group.nameLabel")}</Label>
                  <Input
                    id="rename-group"
                    value={name}
                    maxLength={MAX_GROUP_NAME}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  variant="outline"
                  disabled={!nameChanged}
                  loading={rename.isPending}
                >
                  {t("people.group.saveName")}
                </Button>
              </form>
            ) : null}

            <section className="flex flex-col gap-2">
              <h3 className="text-sm font-semibold">{t("people.group.participants")}</h3>
              <ul
                className="flex flex-col divide-y divide-border/70 rounded-lg border border-border"
                aria-label={t("people.group.participants")}
              >
                {recipients.map((r) => (
                  <li
                    key={r.id}
                    className="flex min-h-12 items-center gap-3 px-3 py-1.5 transition-colors hover:bg-accent/50"
                  >
                    <StatusAvatar
                      userId={r.id}
                      url={r.avatar_url}
                      name={recipientName(r)}
                      size={32}
                    />
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {recipientName(r)}
                      {r.id === me?.id ? (
                        <span className="ml-1 text-xs text-muted-foreground">
                          {t("people.group.you")}
                        </span>
                      ) : null}
                      {r.id === channel.owner_id ? (
                        <span className="ml-1.5 inline-flex items-center gap-1 align-middle text-xs text-brand-text">
                          <Crown className="size-3" aria-hidden /> {t("people.group.owner")}
                        </span>
                      ) : null}
                    </span>
                    {owner && r.id !== me?.id ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive-text hover:bg-danger-soft hover:text-destructive-text"
                        aria-label={t("people.group.removeAria", { name: recipientName(r) })}
                        onClick={() => void removeOne(r.id)}
                        disabled={remove.isPending}
                      >
                        <UserMinus /> {t("people.group.remove")}
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {owner ? (
              <section aria-label={t("people.group.addPeople")} className="flex flex-col gap-2">
                <h3 className="text-sm font-semibold">{t("people.group.addPeople")}</h3>
                {free > 0 ? (
                  <>
                    <PeoplePicker
                      people={people}
                      pending={pending}
                      selected={selected}
                      max={free}
                      onToggle={toggle}
                    />
                    <Button
                      onClick={() => void addSelected()}
                      disabled={selected.size === 0}
                      loading={add.isPending}
                      className="self-end"
                    >
                      {t("people.group.add")}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("people.group.full", { max: MAX_PARTICIPANTS })}
                  </p>
                )}
              </section>
            ) : null}
          </DialogBody>
          <DialogActions
            start={
              !owner ? (
                <Button
                  variant="ghost"
                  className="text-destructive-text hover:bg-danger-soft hover:text-destructive-text"
                  onClick={() => setLeaving(true)}
                >
                  <LogOut /> {t("people.group.leave")}
                </Button>
              ) : undefined
            }
          >
            <DialogClose asChild>
              <Button variant="outline">{t("people.common.close")}</Button>
            </DialogClose>
          </DialogActions>
        </DialogContent>
      </Dialog>
      <AlertDialog open={leaving} onOpenChange={setLeaving}>
        <AlertDialogContent>
          <AlertDialogTitle>{t("people.group.leaveTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("people.group.leaveDescription")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("people.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void leave()}>
              {t("people.group.leaveConfirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
