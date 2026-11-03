import { isApiError, useGetInvite, useJoinInvite, useListGuilds } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ArrowRight, Home, RotateCw, Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { AuthLayout } from "@/components/auth-layout";
import {
  ErrorIllustration,
  NotFoundIllustration,
  VoiceInviteIllustration,
} from "@/components/illustrations";
import { StatePage } from "@/components/state-screen";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useT } from "@/i18n";
import { appMessage } from "@/lib/app-errors";
import { formatDateTime } from "@/lib/format";
import { initials } from "@/lib/guild";
import { appendGuild } from "@/lib/guild-cache";

function HomeButton({ variant = "outline" }: { variant?: "default" | "outline" }) {
  const { t } = useT();
  return (
    <Button asChild variant={variant}>
      <Link to="/">
        <Home /> {t("shell.state.goHome")}
      </Link>
    </Button>
  );
}

/** `/invite/$code`: pré-visualiza o servidor e aceita o convite (a rota já exige sessão). */
export function InvitePage() {
  const { t } = useT();
  const { code } = useParams({ strict: false }) as { code: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const preview = useGetInvite(code, { query: { retry: false } });
  const guilds = useListGuilds();
  const join = useJoinInvite();
  const [joined, setJoined] = useState(false);
  const [joinError, setJoinError] = useState<string>();

  async function accept() {
    try {
      const guild = await join.mutateAsync({ code });
      setJoined(true); // evita piscar "você já está neste servidor" enquanto navega
      appendGuild(qc, guild);
      await navigate({ to: "/channels/$guildId", params: { guildId: guild.id } });
    } catch (e) {
      // O banimento fica na página (o aviso passageiro some); os demais erros seguem só em toast.
      if (isApiError(e) && e.code === "banned") setJoinError(appMessage(e));
      toast.error(appMessage(e));
    }
  }

  const p = preview.data;

  if (preview.isError) {
    const status = isApiError(preview.error) ? preview.error.status : 0;
    const expired = status === 410;
    const missing = status === 404;
    const network = !isApiError(preview.error) || preview.error.status >= 500;
    return (
      <StatePage
        alert
        illustration={
          network ? (
            <ErrorIllustration className="mb-1 h-40 w-auto" />
          ) : (
            <NotFoundIllustration className="mb-1 h-40 w-auto" />
          )
        }
        title={expired ? t("shell.invite.expiredTitle") : t("shell.invite.unavailableTitle")}
        description={
          missing
            ? t("shell.invite.missing")
            : expired
              ? t("shell.invite.expiredBody", { message: appMessage(preview.error) })
              : appMessage(preview.error)
        }
        actions={
          <>
            {network ? (
              <Button onClick={() => void preview.refetch()} loading={preview.isFetching}>
                <RotateCw /> {t("common.retry")}
              </Button>
            ) : null}
            <HomeButton variant={network ? "outline" : "default"} />
          </>
        }
      />
    );
  }

  // Já é membro: não precisa (nem consome) o convite; leva direto ao servidor.
  const member = p && !joined && guilds.data?.find((g) => g.id === p.guild_id);
  if (p && member) {
    return (
      <StatePage
        illustration={<VoiceInviteIllustration className="mb-1 h-40 w-auto" />}
        title={t("shell.invite.alreadyTitle")}
        description={t("shell.invite.alreadyBody", { guild: p.guild_name })}
        actions={
          <>
            <Button asChild>
              <Link to="/channels/$guildId" params={{ guildId: member.id }}>
                {t("shell.invite.open", { name: member.name })} <ArrowRight />
              </Link>
            </Button>
            <HomeButton />
          </>
        }
      />
    );
  }

  return (
    <AuthLayout>
      <Card>
        {preview.isPending ? (
          <CardContent role="status" className="flex flex-col items-center gap-3">
            <Skeleton className="size-16 rounded-2xl" />
            <Skeleton className="h-5 w-40" />
            <Skeleton className="h-4 w-28" />
            <span className="sr-only">{t("shell.invite.loading")}</span>
          </CardContent>
        ) : p ? (
          <>
            <CardHeader className="items-center text-center">
              <div className="flex size-16 items-center justify-center overflow-hidden rounded-2xl bg-secondary text-lg font-semibold">
                {p.guild_icon_url ? (
                  <img src={p.guild_icon_url} alt="" className="size-full object-cover" />
                ) : (
                  initials(p.guild_name)
                )}
              </div>
              <CardDescription>{t("shell.invite.invitedTo")}</CardDescription>
              <CardTitle>{p.guild_name}</CardTitle>
              <CardDescription className="flex items-center justify-center gap-1.5">
                <Users className="size-3.5" aria-hidden />
                {p.expires_at
                  ? t("shell.invite.membersExpires", {
                      members: t("shell.invite.members", { count: p.member_count }),
                      date: formatDateTime(p.expires_at),
                    })
                  : t("shell.invite.members", { count: p.member_count })}
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex-col gap-3">
              {joinError ? (
                <p
                  role="alert"
                  data-testid="join-error"
                  className="w-full text-center text-sm text-destructive-text"
                >
                  {joinError}
                </p>
              ) : null}
              <Button
                className="w-full"
                size="lg"
                onClick={() => void accept()}
                loading={join.isPending}
              >
                {t("shell.invite.join")}
              </Button>
            </CardFooter>
          </>
        ) : null}
      </Card>
    </AuthLayout>
  );
}
