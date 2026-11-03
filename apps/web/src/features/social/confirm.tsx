import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useT } from "@/i18n";

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
  const { t } = useT();
  const block = confirm?.kind === "block";
  return (
    <AlertDialog open={!!confirm} onOpenChange={(o) => !o && onCancel()}>
      <AlertDialogContent>
        <AlertDialogTitle>
          {block
            ? t("people.confirm.blockTitle", { name: confirm?.name ?? "" })
            : t("people.confirm.removeTitle", { name: confirm?.name ?? "" })}
        </AlertDialogTitle>
        <AlertDialogDescription>
          {block ? t("people.confirm.blockDescription") : t("people.confirm.removeDescription")}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("people.common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={() => confirm && onConfirm(confirm)}>
            {block ? t("people.person.block") : t("people.person.removeFriend")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
