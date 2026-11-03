import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export type SocialConfirm =
  | { kind: "remove"; userId: string; name: string }
  | { kind: "block"; userId: string; name: string };

/** Confirmação de "Remover amigo" e "Bloquear" (ações que desfazem a amizade). */
export function SocialConfirmDialog({
  confirm,
  onCancel,
  onConfirm,
}: {
  confirm: SocialConfirm | null;
  onCancel: () => void;
  onConfirm: (c: SocialConfirm) => void;
}) {
  const block = confirm?.kind === "block";
  return (
    <AlertDialog open={!!confirm} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogTitle>
          {block ? `Bloquear ${confirm?.name}?` : `Remover ${confirm?.name} dos amigos?`}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {block
            ? "Vocês deixam de ser amigos e nenhum dos dois poderá iniciar conversas privadas ou ligar um para o outro. As mensagens dessa pessoa ficam recolhidas para você, e as menções dela não geram aviso. Ela não é avisada do bloqueio."
            : "Vocês deixam de ser amigos. As conversas continuam existindo enquanto compartilharem um servidor."}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancelar</AlertDialogCancel>
          <AlertDialogAction onClick={() => confirm && onConfirm(confirm)}>
            {block ? "Bloquear" : "Remover amigo"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
