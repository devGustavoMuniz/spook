import {
  type InvitePayload,
  Permission,
  useCreateInvite,
  useListInvites,
  useRevokeInvite,
} from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Copy, Link2, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { appMessage } from "@/lib/app-errors";
import { formatDateTime } from "@/lib/format";
import { can, type Guild } from "@/lib/guild";
import { queryKeys } from "@/lib/queryKeys";

const EXPIRY_OPTIONS = [
  { value: "0", label: "Nunca" },
  { value: "1800", label: "30 minutos" },
  { value: "3600", label: "1 hora" },
  { value: "21600", label: "6 horas" },
  { value: "43200", label: "12 horas" },
  { value: "86400", label: "1 dia" },
  { value: "604800", label: "7 dias" },
];

export const inviteLink = (code: string) => `${window.location.origin}/invite/${code}`;

export function InvitesTab({ guild }: { guild: Guild }) {
  const qc = useQueryClient();
  const canList = can(guild, Permission.MANAGE_GUILD);
  const list = useListInvites(guild.id, { query: { enabled: canList } });
  const create = useCreateInvite();
  const [expires, setExpires] = useState("0");
  const [maxUses, setMaxUses] = useState("");
  const [created, setCreated] = useState<InvitePayload[]>([]);
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const uses = maxUses.trim() === "" ? undefined : Number(maxUses);
    if (uses !== undefined && (!Number.isInteger(uses) || uses < 1 || uses > 1_000_000)) {
      setError("Use um número inteiro de 1 a 1.000.000, ou deixe em branco.");
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
      await qc.invalidateQueries({ queryKey: queryKeys.invites(guild.id) });
      await copy(invite.code);
    } catch (err) {
      toast.error(appMessage(err));
    }
  }

  const invites = canList ? (list.data ?? []) : created;

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={submit}
        noValidate
        className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-expires">Expira em</Label>
          <Select value={expires} onValueChange={setExpires}>
            <SelectTrigger id="invite-expires" aria-label="Expiração do convite">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EXPIRY_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="invite-max">Limite de usos</Label>
          <Input
            id="invite-max"
            inputMode="numeric"
            placeholder="Ilimitado"
            value={maxUses}
            aria-invalid={!!error}
            aria-describedby={error ? "invite-max-error" : undefined}
            onChange={(e) => setMaxUses(e.target.value)}
          />
        </div>
        <Button type="submit" disabled={create.isPending}>
          <Link2 /> Criar convite
        </Button>
        {error ? (
          <p
            id="invite-max-error"
            role="alert"
            className="text-xs text-destructive-text sm:col-span-3"
          >
            {error}
          </p>
        ) : null}
      </form>

      <section aria-label="Convites ativos" className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Convites ativos</h3>
        {canList && list.isPending ? (
          <p className="text-sm text-muted-foreground">Carregando…</p>
        ) : invites.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {canList
              ? "Nenhum convite ativo."
              : "Os convites que você criar nesta sessão aparecem aqui."}
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {invites.map((inv) => (
              <InviteRow key={inv.code} invite={inv} guildId={guild.id} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

async function copy(code: string) {
  try {
    await navigator.clipboard.writeText(inviteLink(code));
    toast.success("Link do convite copiado.");
  } catch {
    toast.message(`Link do convite: ${inviteLink(code)}`);
  }
}

function InviteRow({ invite, guildId }: { invite: InvitePayload; guildId: string }) {
  const qc = useQueryClient();
  const revoke = useRevokeInvite();
  const [revoked, setRevoked] = useState(false);

  async function onRevoke() {
    try {
      await revoke.mutateAsync({ code: invite.code });
      setRevoked(true);
      await qc.invalidateQueries({ queryKey: queryKeys.invites(guildId) });
      toast.success("Convite revogado.");
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  if (revoked) return null;
  return (
    <li className="flex flex-wrap items-center gap-3 px-3 py-2">
      <div className="min-w-0 flex-1">
        <p className="font-mono text-sm">{invite.code}</p>
        <p className="text-xs text-muted-foreground">
          {invite.uses}
          {invite.max_uses ? `/${invite.max_uses}` : ""} {invite.uses === 1 ? "uso" : "usos"} ·{" "}
          {invite.expires_at ? `expira em ${formatDateTime(invite.expires_at)}` : "não expira"}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        aria-label={`Copiar link do convite ${invite.code}`}
        onClick={() => void copy(invite.code)}
      >
        <Copy /> Copiar link
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className="text-destructive-text"
        aria-label={`Revogar convite ${invite.code}`}
        onClick={() => void onRevoke()}
        disabled={revoke.isPending}
      >
        <Trash2 /> Revogar
      </Button>
    </li>
  );
}
