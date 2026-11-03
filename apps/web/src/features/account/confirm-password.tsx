import {
  isApiError,
  PASSWORD_CONFIRMATION_REQUIRED,
  useConfirmPassword as useConfirmPasswordMutation,
} from "@spook/shared";
import { KeyRound } from "lucide-react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from "react";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

/** A pessoa fechou o diálogo "Confirme sua senha" sem confirmar. */
export class ConfirmationCancelled extends Error {
  constructor() {
    super("Confirmação de senha cancelada.");
    this.name = "ConfirmationCancelled";
  }
}

export const isConfirmationCancelled = (e: unknown): e is ConfirmationCancelled =>
  e instanceof ConfirmationCancelled;

/** O servidor pediu a senha de novo (403 `password_confirmation_required`). */
export const needsPasswordConfirmation = (e: unknown) =>
  isApiError(e) && e.status === 403 && e.code === PASSWORD_CONFIRMATION_REQUIRED;

type Ctx = { request: () => Promise<boolean> };
const ConfirmContext = createContext<Ctx | null>(null);

/**
 * Hook das ações sensíveis (trocar e-mail, excluir servidor...): `run(ação)` executa a ação; se o servidor
 * responder que a senha precisa ser confirmada, abre o diálogo "Confirme sua senha" e, confirmada, repete a
 * ação uma vez. Cancelar lança `ConfirmationCancelled` (use `isConfirmationCancelled` para não mostrar erro).
 * Sem o provider (testes isolados) a ação roda direto.
 */
export function useConfirmPassword() {
  const ctx = useContext(ConfirmContext);
  const run = useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (e) {
        if (!ctx || !needsPasswordConfirmation(e)) throw e;
      }
      if (!ctx || !(await ctx.request())) throw new ConfirmationCancelled();
      return action();
    },
    [ctx],
  );
  /** Abre o diálogo "Confirme sua senha" agora (para ações que saem do app, como vincular um provedor). */
  const confirmNow = useCallback(async (): Promise<boolean> => (ctx ? ctx.request() : true), [ctx]);
  return { run, confirmNow };
}

/** Monta o diálogo uma vez para a área autenticada. */
export function ConfirmPasswordProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const pending = useRef<((ok: boolean) => void) | null>(null);

  const settle = useCallback((ok: boolean) => {
    pending.current?.(ok);
    pending.current = null;
    setOpen(false);
  }, []);

  const request = useCallback(
    () =>
      new Promise<boolean>((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setOpen(true);
      }),
    [],
  );
  const value = useMemo(() => ({ request }), [request]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <ConfirmPasswordDialog open={open} onSettle={settle} />
    </ConfirmContext.Provider>
  );
}

function ConfirmPasswordDialog({
  open,
  onSettle,
}: {
  open: boolean;
  onSettle: (ok: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onSettle(false)}>
      <DialogContent size="sm" flush>
        {open ? <ConfirmForm onSettle={onSettle} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmForm({ onSettle }: { onSettle: (ok: boolean) => void }) {
  const confirm = useConfirmPasswordMutation();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!password) {
      setError("Informe a senha.");
      return;
    }
    setError(undefined);
    try {
      await confirm.mutateAsync({ data: { password } });
      onSettle(true);
    } catch (err) {
      if (isApiError(err) && err.status === 422) setError("Senha incorreta.");
      else if (isApiError(err) && err.status === 429)
        setError("Muitas tentativas. Aguarde um instante e tente de novo.");
      else setError("Não foi possível confirmar a senha. Tente novamente.");
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <DialogHead
        icon={KeyRound}
        title="Confirme sua senha"
        description="Esta ação é sensível. Digite sua senha para continuar; a confirmação vale por 10 minutos."
      />
      <DialogBody>
        <Field id="confirm-password" label="Senha" error={error}>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            aria-invalid={!!error}
            aria-describedby={describedBy("confirm-password", error)}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </DialogBody>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={() => onSettle(false)}>
          Cancelar
        </Button>
        <Button type="submit" loading={confirm.isPending}>
          Confirmar
        </Button>
      </DialogActions>
    </form>
  );
}
