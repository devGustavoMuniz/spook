import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { isTauri } from "@/desktop/runtime";
import { useT } from "@/i18n";

/** "Baixar o app": só na web (dentro do app desktop não faz sentido). */
export function DownloadAppButton({ variant = "ghost" }: { variant?: "ghost" | "outline" }) {
  const { t } = useT();
  if (isTauri()) return null;
  return (
    <Button asChild variant={variant}>
      <Link to="/download">
        <Download aria-hidden /> {t("shell.download.button")}
      </Link>
    </Button>
  );
}

/** Item de menu suspenso (menu do servidor). */
export function DownloadAppMenuItem() {
  const { t } = useT();
  if (isTauri()) return null;
  return (
    <DropdownMenuItem asChild>
      <Link to="/download">
        <Download /> {t("shell.download.button")}
      </Link>
    </DropdownMenuItem>
  );
}
