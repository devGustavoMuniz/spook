import { isApiError } from "@spook/shared";
import { Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogActions, DialogContent, DialogHead } from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { useOpenNitro } from "./use-open-nitro";

/** O servidor recusou a imagem animada por falta de Nitro (403 `nitro_required`)? */
export const isNitroRequired = (e: unknown): boolean =>
  isApiError(e) && e.status === 403 && e.code === "nitro_required";

/** Aviso "Requer Nitro" com atalho para a seção Nitro (upload de GIF/animado sem plano). */
export function NitroRequiredDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useT();
  const openNitro = useOpenNitro();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHead
          icon={Zap}
          title={t("nitro.required.title")}
          description={t("nitro.required.description")}
        />
        <DialogActions>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("nitro.required.dismiss")}
          </Button>
          <Button
            onClick={() => {
              onOpenChange(false);
              openNitro();
            }}
          >
            {t("nitro.required.cta")}
          </Button>
        </DialogActions>
      </DialogContent>
    </Dialog>
  );
}
