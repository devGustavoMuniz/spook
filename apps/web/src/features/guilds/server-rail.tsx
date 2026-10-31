import miniLogo from "@spook/brand/assets/mini-logo.svg";
import { Link } from "@tanstack/react-router";
import { LogOut, Plus, Settings } from "lucide-react";
import { useState } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type Guild, initials } from "@/lib/guild";
import { AddServerDialog } from "./add-server-dialog";

const itemClass =
  "flex size-12 items-center justify-center overflow-hidden rounded-[1.5rem] bg-secondary text-sm font-semibold text-secondary-foreground transition-[border-radius,background-color] hover:rounded-xl hover:bg-primary hover:text-primary-foreground data-[status=active]:rounded-xl data-[status=active]:bg-primary data-[status=active]:text-primary-foreground";

export function ServerRail({ guilds }: { guilds: Guild[] }) {
  const [adding, setAdding] = useState(false);
  const { signOut, pending } = useSignOut();
  return (
    <nav
      aria-label="Servidores"
      className="flex w-[4.5rem] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-sidebar py-3"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/" aria-label="Início" className={itemClass}>
            <img src={miniLogo} alt="" className="size-8" />
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Início</TooltipContent>
      </Tooltip>
      <hr className="w-8 border-border" />
      <ul className="flex flex-col items-center gap-2">
        {guilds.map((g) => (
          <li key={g.id}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Link
                  to="/channels/$guildId"
                  params={{ guildId: g.id }}
                  aria-label={g.name}
                  className={itemClass}
                  activeOptions={{ exact: false }}
                >
                  {g.icon_url ? (
                    <img src={g.icon_url} alt="" className="size-full object-cover" />
                  ) : (
                    <span aria-hidden>{initials(g.name)}</span>
                  )}
                </Link>
              </TooltipTrigger>
              <TooltipContent side="right">{g.name}</TooltipContent>
            </Tooltip>
          </li>
        ))}
      </ul>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Adicionar um servidor"
            onClick={() => setAdding(true)}
            className={`${itemClass} text-primary`}
          >
            <Plus />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right">Criar servidor ou entrar com convite</TooltipContent>
      </Tooltip>
      <div className="mt-auto flex flex-col items-center gap-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/settings/profile"
              aria-label="Configurações do perfil"
              className="flex size-9 items-center justify-center rounded-md hover:bg-accent"
            >
              <Settings className="size-4" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right">Perfil</TooltipContent>
        </Tooltip>
        <ThemeToggle />
        <Button variant="ghost" size="icon" aria-label="Sair" onClick={signOut} disabled={pending}>
          <LogOut />
        </Button>
      </div>
      <AddServerDialog open={adding} onOpenChange={setAdding} />
    </nav>
  );
}
