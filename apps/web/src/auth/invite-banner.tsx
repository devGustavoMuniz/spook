import { Link } from "@tanstack/react-router";
import { Ticket } from "lucide-react";
import { Button } from "@/components/ui/button";

/** Código do convite se o destino pós-login for `/invite/<código>` (a API de convites exige sessão). */
export function inviteCodeOf(redirect?: string): string | undefined {
  return redirect?.match(/^\/invite\/([^/?#]+)/)?.[1];
}

/**
 * Contexto do convite nas telas de entrada. O nome do servidor só é consultável com sessão,
 * então aqui avisamos do convite e oferecemos entrar ou criar conta, preservando o `redirect`.
 */
export function InviteBanner({
  redirect,
  current,
}: {
  redirect: string;
  current: "login" | "register";
}) {
  return (
    <section
      aria-label="Convite recebido"
      className="flex flex-col gap-3 rounded-lg border border-brand-400/40 bg-accent p-3"
    >
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground">
          <Ticket className="size-4" aria-hidden="true" />
        </span>
        <p className="text-sm text-pretty">
          <strong className="font-semibold">Você recebeu um convite para um servidor.</strong>{" "}
          <span className="text-muted-foreground">
            Entre ou crie uma conta para ver o servidor e aceitar.
          </span>
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <Button asChild size="sm" variant={current === "login" ? "default" : "outline"}>
          <Link
            to="/login"
            search={{ redirect }}
            aria-current={current === "login" ? "page" : undefined}
          >
            Entrar
          </Link>
        </Button>
        <Button asChild size="sm" variant={current === "register" ? "default" : "outline"}>
          <Link
            to="/register"
            search={{ redirect }}
            aria-current={current === "register" ? "page" : undefined}
          >
            Criar conta
          </Link>
        </Button>
      </div>
    </section>
  );
}
