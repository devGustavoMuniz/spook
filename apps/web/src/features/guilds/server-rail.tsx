import miniLogo from "@spook/brand/assets/mini-logo.svg";
import { useGetMe } from "@spook/shared";
import { Link } from "@tanstack/react-router";
import { BellOff, LogOut, Plus, Settings, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  MentionBadge,
  mentionLabel,
  UnreadDot,
  useDmTotals,
  useGuildTotals,
} from "@/features/notifications/badges";
import { NotificationMenuItems } from "@/features/notifications/notification-menu";
import { useIsMuted } from "@/features/notifications/settings";
import { type Guild, initials } from "@/lib/guild";
import { AddServerDialog } from "./add-server-dialog";

const itemClass =
  "flex size-12 items-center justify-center overflow-hidden rounded-[1.5rem] bg-secondary text-sm font-semibold text-secondary-foreground transition-[border-radius,background-color] hover:rounded-xl hover:bg-primary hover:text-primary-foreground data-[status=active]:rounded-xl data-[status=active]:bg-primary data-[status=active]:text-primary-foreground";

function GuildButton({ guild: g }: { guild: Guild }) {
  const t = useGuildTotals(g.id);
  const muted = useIsMuted("guild", g.id);
  const [menu, setMenu] = useState(false);
  return (
    <li
      className={`relative ${muted ? "opacity-60" : ""}`}
      data-muted={muted || undefined}
      onContextMenu={(e) => {
        e.preventDefault(); // sem componente de menu de contexto: abre o mesmo menu do servidor
        setMenu(true);
      }}
    >
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <span aria-hidden className="pointer-events-none absolute inset-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start" className="w-60">
          <DropdownMenuLabel>{g.name}</DropdownMenuLabel>
          <NotificationMenuItems
            scope="guild"
            targetId={g.id}
            what="o servidor"
            isGuildLike
            withSeparator={false}
          />
        </DropdownMenuContent>
      </DropdownMenu>
      {t.unread > 0 || t.mentions > 0 ? (
        <span
          aria-hidden
          className="absolute top-1/2 -left-3 h-2 w-1 -translate-y-1/2 rounded-r-full bg-foreground"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <Link
            to="/channels/$guildId"
            params={{ guildId: g.id }}
            aria-label={g.name}
            className={`${itemClass} relative`}
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
      {t.mentions > 0 ? (
        <MentionBadge
          count={t.mentions}
          label={mentionLabel(t.mentions, g.name)}
          className="pointer-events-none absolute -right-1 -bottom-1 ring-2 ring-sidebar"
        />
      ) : muted ? (
        <BellOff
          role="img"
          aria-label="Servidor silenciado"
          className="pointer-events-none absolute -right-1 -bottom-1 size-4 rounded-full bg-sidebar p-0.5"
        />
      ) : null}
    </li>
  );
}

export function ServerRail({ guilds }: { guilds: Guild[] }) {
  const [adding, setAdding] = useState(false);
  const { signOut, pending } = useSignOut();
  const dms = useDmTotals();
  const { data: me } = useGetMe();
  return (
    <nav
      aria-label="Servidores"
      className="flex w-[4.5rem] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-sidebar py-3"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Link to="/channels/@me" aria-label="Início" className={`${itemClass} relative`}>
            <img src={miniLogo} alt="" className="size-8" />
            {dms.mentions > 0 ? (
              <MentionBadge
                count={dms.mentions}
                label={`${dms.mentions > 99 ? "99+" : dms.mentions} mensagens diretas não lidas`}
                className="absolute -right-1 -bottom-1 ring-2 ring-sidebar"
              />
            ) : dms.unread > 0 ? (
              <UnreadDot
                label="Mensagens diretas novas"
                className="absolute right-0 bottom-0 size-3 ring-2 ring-sidebar"
              />
            ) : null}
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right">Início (mensagens diretas)</TooltipContent>
      </Tooltip>
      <hr className="w-8 border-border" />
      <ul className="flex flex-col items-center gap-2">
        {guilds.map((g) => (
          <GuildButton key={g.id} guild={g} />
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
        {me?.is_admin ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/admin"
                aria-label="Painel de administração"
                className="flex size-9 items-center justify-center rounded-md hover:bg-accent"
              >
                <ShieldCheck className="size-4" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right">Painel de administração</TooltipContent>
          </Tooltip>
        ) : null}
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
