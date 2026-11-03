import { isApiError, useGetInvite, useJoinInvite, useListGuilds } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, LinkIcon, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { initials } from "@/lib/guild";
import { appendGuild } from "@/lib/guild-cache";
import { extractInviteCodes } from "@/lib/invite-links";

/** Convites mudam pouco: um cartão por código e por 5 min, mesmo que o link apareça em várias mensagens. */
const STALE_MS = 5 * 60_000;

/**
 * Cartão de convite: ícone (ou iniciais), nome do servidor, nº de membros e "Entrar" (ou "Abrir servidor" se já sou
 * membro). Usa o endpoint autenticado de pré-visualização (`useGetInvite`), em cache por código (sem N+1).
 * `preview` (composer): só mostra o servidor, sem ação.
 */
export function InviteCard({ code, preview = false }: { code: string; preview?: boolean }) {
  const { t } = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const invite = useGetInvite(code, { query: { retry: false, staleTime: STALE_MS } });
  const guilds = useListGuilds();
  const join = useJoinInvite();
  const p = invite.data;

  const shell = "flex max-w-md items-center gap-3 rounded-xl border border-border bg-surface-1 p-3";

  if (invite.isPending)
    return (
      <output className={shell}>
        <Skeleton className="size-12 rounded-xl" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-20" />
        </div>
        <span className="sr-only">{t("chat.invite.loading")}</span>
      </output>
    );

  if (invite.isError || !p) {
    const status = isApiError(invite.error) ? invite.error.status : 0;
    const expired = status === 410;
    const invalid = status === 404;
    return (
      <div role="note" className={shell} data-invite-state={expired ? "expired" : "invalid"}>
        <span className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground">
          <LinkIcon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {expired
              ? t("chat.invite.expired")
              : invalid
                ? t("chat.invite.invalid")
                : t("chat.invite.unavailable")}
          </p>
          <p className="text-xs text-muted-foreground">
            {expired
              ? t("chat.invite.expiredHint")
              : invalid
                ? t("chat.invite.invalidHint")
                : t("chat.invite.unavailableHint")}
          </p>
        </div>
      </div>
    );
  }

  const mine = guilds.data?.find((g) => g.id === p.guild_id);

  async function accept() {
    try {
      const guild = await join.mutateAsync({ code });
      appendGuild(qc, guild);
      await navigate({ to: "/channels/$guildId", params: { guildId: guild.id } });
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  return (
    <div className={shell} data-invite-state="ok">
      <span className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-secondary text-sm font-semibold">
        {p.guild_icon_url ? (
          <img src={p.guild_icon_url} alt="" className="size-full object-cover" />
        ) : (
          initials(p.guild_name)
        )}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("chat.invite.title")}
        </p>
        <p className="truncate text-sm font-semibold">{p.guild_name}</p>
        <p className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="size-3" aria-hidden />
          {t("chat.invite.members", { count: p.member_count })}
        </p>
      </div>
      {preview ? null : mine ? (
        <Button asChild size="sm" variant="secondary" className="shrink-0">
          <Link to="/channels/$guildId" params={{ guildId: mine.id }}>
            {t("chat.invite.open")} <ArrowRight />
          </Link>
        </Button>
      ) : (
        <Button
          size="sm"
          className="shrink-0"
          loading={join.isPending}
          aria-label={t("chat.invite.joinAria", { name: p.guild_name })}
          onClick={() => void accept()}
        >
          {t("chat.invite.join")}
        </Button>
      )}
    </div>
  );
}

/** Cartões dos links de convite do próprio domínio num texto (vazio se não houver). */
export function InviteCards({ content }: { content: string }) {
  const codes = extractInviteCodes(content);
  if (codes.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {codes.map((c) => (
        <InviteCard key={c} code={c} />
      ))}
    </div>
  );
}
