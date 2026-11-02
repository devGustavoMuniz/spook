import { Link } from "@tanstack/react-router";
import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { isTauri } from "@/desktop/runtime";

/** "Baixar o app": só na web (dentro do app desktop não faz sentido). */
export function DownloadAppButton({ variant = "ghost" }: { variant?: "ghost" | "outline" }) {
  if (isTauri()) return null;
  return (
    <Button asChild variant={variant}>
      <Link to="/download">
        <Download aria-hidden /> Baixar o app
      </Link>
    </Button>
  );
}

/** Item de menu suspenso (menu do servidor). */
export function DownloadAppMenuItem() {
  if (isTauri()) return null;
  return (
    <DropdownMenuItem asChild>
      <Link to="/download">
        <Download /> Baixar o app
      </Link>
    </DropdownMenuItem>
  );
}
