import {
  type InvitePayload,
  Permission,
  useCreateInvite,
  useListInvites,
  useRevokeInvite,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Clock, Copy, Link2, Ticket, Trash2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DialogBody } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { type MessageKey, t as tGlobal, useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { formatDateTime } from "@/lib/format";
import { can, type Guild } from "@/lib/guild";
import { queryKeys } from "@/lib/queryKeys";

const EXPIRY_OPTIONS: { value: string; labelKey: MessageKey }[] = [
  { value: "0", labelKey: "guilds.invites.expiry.never" },
  { value: "1800", labelKey: "guilds.invites.expiry.30m" },
  { value: "3600", labelKey: "guilds.invites.expiry.1h" },
  { value: "21600", labelKey: "guilds.invites.expiry.6h" },
  { value: "43200", labelKey: "guilds.invites.expiry.12h" },
  { value: "86400", labelKey: "guilds.invites.expiry.1d" },
  { value: "604800", labelKey: "guilds.invites.expiry.7d" },
];

export const inviteLink = (code: string) => `${window.location.origin}/invite/${code}`;

export function InvitesTab({ guild }: { guild: Guild }) {
  const { t } = useT();
  const qc = useQueryClient();
  const canList = can(guild, Permission.MANAGE_GUILD);
  const list = useListInvites(guild.id, { query: { enabled: canList } });
  const create = useCreateInvite();
  const [expires, setExpires] = useState("0");
  const [maxUses, setMaxUses] = useState("");
  const [created, setCreated] = useState<InvitePayload[]>([]);
  const [error, setError] = useState<string>();
  const [fresh, setFresh] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const uses = maxUses.trim() === "" ? undefined : Number(maxUses);
    if (uses !== undefined && (!Number.isInteger(uses) || uses < 1 || uses > 1_000_000)) {
      setError(t("guilds.invites.maxError"));
      return;
    }
    setError(undefined);
    try {
      const invite = await create.mutateAsync({
        guildId: guild.id,
        data: {
          ...(expires !== "0" ? { expires_in: Number(expires) } : {}),
          ...(uses ? { max_uses: uses } : {}),
        },
      });
      setCreated((c) => [invite, ...c]);
      setFresh(invite.code);
      await qc.invalidateQueries({ queryKey: queryKeys.invites(guild.id) });
      await copyLink(invite.code);
    } catch (err) {
      toast.error(appMessage(err));
    }
  }

  const invites = canList ? (list.data ?? []) : created;

  return (
    <DialogBody className="gap-6">
      <form
        onSubmit={submit}
        noValidate
        aria-label={t("guilds.invites.formAria")}
        className="flex flex-col gap-4 rounded-xl border border-border bg-surface-1 p-4"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-expires">{t("guilds.invites.expires")}</Label>
            <Select value={expires} onValueChange={setExpires}>
              <SelectTrigger id="invite-expires" aria-label={t("guilds.invites.expiresAria")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {t(o.labelKey)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="invite-max">{t("guilds.invites.maxUses")}</Label>
            <Input
              id="invite-max"
              inputMode="numeric"
              placeholder={t("guilds.invites.unlimited")}
              value={maxUses}
              aria-invalid={!!error}
              aria-describedby={error ? "invite-max-error" : undefined}
              onChange={(e) => setMaxUses(e.target.value)}
            />
          </div>
        </div>
        {error ? (
          <p id="invite-max-error" role="alert" className="text-xs text-destructive-text">
            {error}
          </p>
        ) : null}
        <Button type="submit" loading={create.isPending} className="self-end">
          <Link2 /> {t("guilds.invites.create")}
        </Button>
      </form>

      <section aria-label={t("guilds.invites.activeTitle")} className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">{t("guilds.invites.activeTitle")}</h3>
        {canList && list.isPending ? (
          <output className="flex flex-col gap-2">
            <Skeleton className="h-20 w-full rounded-xl" />
            <Skeleton className="h-20 w-full rounded-xl" />
            <span className="sr-only">{t("guilds.common.loading")}</span>
          </output>
        ) : canList && list.isError ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-destructive/40 p-4 text-sm"
          >
            <span className="text-destructive-text">{appMessage(list.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void list.refetch()}>
              {t("guilds.common.retry")}
            </Button>
          </div>
        ) : invites.length === 0 ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center">
            <Ticket aria-hidden className="size-7 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              {canList ? t("guilds.invites.empty") : t("guilds.invites.emptyNoList")}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {invites.map((inv) => (
              <InviteRow
                key={inv.code}
                invite={inv}
                guildId={guild.id}
                fresh={inv.code === fresh}
              />
            ))}
          </ul>
        )}
      </section>
    </DialogBody>
  );
}

async function copyLink(code: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(inviteLink(code));
    toast.success(tGlobal("guilds.invites.copiedToast"));
    return true;
  } catch {
    toast.message(tGlobal("guilds.invites.linkToast", { link: inviteLink(code) }));
    return false;
  }
}

/** Cartão de convite: código, link, usos e validade, com copiar (feedback "Copiado") e revogar (com confirmação). */
function InviteRow({
  invite,
  guildId,
  fresh,
}: {
  invite: InvitePayload;
  guildId: string;
  fresh?: boolean;
}) {
  const { t } = useT();
  const qc = useQueryClient();
  const revoke = useRevokeInvite();
  const [revoked, setRevoked] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function onRevoke() {
    try {
      await revoke.mutateAsync({ code: invite.code });
      setRevoked(true);
      await qc.invalidateQueries({ queryKey: queryKeys.invites(guildId) });
      toast.success(t("guilds.invites.revoked"));
    } catch (e) {
      toast.error(appMessage(e));
    } finally {
      setConfirm(false);
    }
  }

  if (revoked) return null;
  return (
    <li
      className={`flex flex-col gap-3 rounded-xl border bg-card p-3.5 shadow-xs sm:flex-row sm:items-center ${fresh ? "border-brand-400" : "border-border"}`}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-mono text-base font-semibold tracking-wide">{invite.code}</p>
          {fresh ? <Badge variant="brand">{t("guilds.invites.new")}</Badge> : null}
        </div>
        <span className="truncate text-xs text-muted-foreground" data-testid="invite-link">
          {inviteLink(invite.code)}
        </span>
        <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Users className="size-3" aria-hidden />
            <span className="tabular">
              {invite.uses}
              {invite.max_uses ? `/${invite.max_uses}` : ""}
            </span>{" "}
            {t("guilds.invites.usesUnit", { count: invite.uses })}
          </span>
          <span className="inline-flex items-center gap-1">
            <Clock className="size-3" aria-hidden />
            {invite.expires_at
              ? t("guilds.invites.expiresAt", { date: formatDateTime(invite.expires_at) })
              : t("guilds.invites.neverExpires")}
          </span>
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Button
          variant={copied ? "soft" : "outline"}
          size="sm"
          aria-label={t("guilds.invites.copyAria", { code: invite.code })}
          onClick={() => void copyLink(invite.code).then((ok) => ok && setCopied(true))}
        >
          {copied ? <Check /> : <Copy />}{" "}
          {copied ? t("guilds.invites.copied") : t("guilds.invites.copy")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive-text hover:bg-danger-soft hover:text-destructive-text"
          aria-label={t("guilds.invites.revokeAria", { code: invite.code })}
          onClick={() => setConfirm(true)}
          disabled={revoke.isPending}
        >
          <Trash2 /> {t("guilds.invites.revoke")}
        </Button>
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("guilds.invites.revokeTitle", { code: invite.code })}
          </AlertDialogTitle>
          <AlertDialogDescription>{t("guilds.invites.revokeBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("guilds.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void onRevoke()}>
              {t("guilds.invites.revoke")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </li>
  );
}
