import { isApiError, useDesktopAuthorize, useGetMe } from "@spook/shared";
import { Link, useSearch } from "@tanstack/react-router";
import { CircleCheck, Laptop, LinkIcon } from "lucide-react";
import { useState } from "react";
import { StatusCard } from "@/auth/status-card";
import { Button } from "@/components/ui/button";
import { messageFor } from "@/lib/errors";
import { navigateTo } from "@/lib/navigate";

const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;

/**
 * Login do app desktop pelo navegador: a pessoa (já logada, ou depois de entrar) confirma "Entrar no app do
 * computador"; o backend gera um código de uso único (60 s) e a página abre o deep link `spook://auth?code=`.
 */
export function DesktopLoginPage() {
  const { code_challenge: challenge } = useSearch({ strict: false }) as { code_challenge?: string };
  const { data: me } = useGetMe();
  const authorize = useDesktopAuthorize();
  const [link, setLink] = useState<string>();
  const [error, setError] = useState<string>();

  if (!challenge || !CHALLENGE.test(challenge))
    return (
      <StatusCard
        icon={LinkIcon}
        tone="danger"
        title="Link inválido"
        description="Abra o Spook no computador e escolha “Entrar pelo navegador” de novo."
        actions={
          <Button asChild variant="outline" size="lg">
            <Link to="/">Ir para o Spook</Link>
          </Button>
        }
      />
    );

  if (link)
    return (
      <StatusCard
        icon={CircleCheck}
        tone="success"
        title="Pronto! Volte ao app"
        description="Se o Spook não abriu sozinho, clique em “Abrir o app”. O código vale por 60 segundos."
        actions={
          <Button asChild size="lg">
            <a href={link}>Abrir o app</a>
          </Button>
        }
      />
    );

  async function confirm() {
    setError(undefined);
    try {
      const res = await authorize.mutateAsync({ data: { code_challenge: challenge as string } });
      setLink(res.redirect_url);
      navigateTo(res.redirect_url);
    } catch (e) {
      setError(
        isApiError(e) && e.status === 401
          ? "Sua sessão expirou. Entre de novo e repita o processo."
          : messageFor(e),
      );
    }
  }

  return (
    <StatusCard
      icon={Laptop}
      title="Entrar no app do computador"
      description={
        me
          ? `Você está conectado como @${me.username}. Confirme para entrar com esta conta no Spook do seu computador.`
          : "Confirme para entrar no Spook do seu computador."
      }
      actions={
        <>
          <Button size="lg" loading={authorize.isPending} onClick={() => void confirm()}>
            Entrar no app do computador
          </Button>
          <Button asChild variant="ghost" size="lg">
            <Link to="/">Cancelar</Link>
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Só confirme se foi você quem pediu. Se não reconhece este pedido, feche esta página.
      </p>
    </StatusCard>
  );
}
