import { isApiError, useGetInvite, useJoinInvite } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { toast } from "sonner";
import { AuthLayout } from "@/components/auth-layout";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { appMessage } from "@/lib/app-errors";
import { formatDateTime } from "@/lib/format";
import { initials } from "@/lib/guild";
import { appendGuild } from "@/lib/guild-cache";

/** `/invite/$code`: pré-visualiza o servidor e aceita o convite (a rota já exige sessão). */
export function InvitePage() {
  const { code } = useParams({ strict: false }) as { code: string };
  const qc = useQueryClient();
  const navigate = useNavigate();
  const preview = useGetInvite(code, { query: { retry: false } });
  const join = useJoinInvite();

  async function accept() {
    try {
      const guild = await join.mutateAsync({ code });
      appendGuild(qc, guild);
      await navigate({ to: "/channels/$guildId", params: { guildId: guild.id } });
    } catch (e) {
      toast.error(appMessage(e));
    }
  }

  const p = preview.data;
  return (
    <AuthLayout>
      <Card>
        {preview.isPending ? (
          <CardContent role="status">Carregando convite…</CardContent>
        ) : preview.isError ? (
          <>
            <CardHeader>
              <CardTitle>
                {isApiError(preview.error) && preview.error.status === 410
                  ? "Convite expirado"
                  : "Convite indisponível"}
              </CardTitle>
              <CardDescription role="alert">
                {isApiError(preview.error) && preview.error.status === 404
                  ? "Esse convite não existe ou foi revogado."
                  : appMessage(preview.error)}
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button asChild variant="outline">
                <Link to="/">Ir para o início</Link>
              </Button>
            </CardFooter>
          </>
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
              <CardDescription>Você foi convidado para entrar em</CardDescription>
              <CardTitle>{p.guild_name}</CardTitle>
              <CardDescription>
                {p.member_count} {p.member_count === 1 ? "membro" : "membros"}
                {p.expires_at ? ` · expira em ${formatDateTime(p.expires_at)}` : ""}
              </CardDescription>
            </CardHeader>
            <CardFooter>
              <Button className="w-full" onClick={() => void accept()} disabled={join.isPending}>
                {join.isPending ? "Entrando…" : "Entrar no servidor"}
              </Button>
            </CardFooter>
          </>
        ) : null}
      </Card>
    </AuthLayout>
  );
}
