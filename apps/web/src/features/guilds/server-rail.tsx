import miniLogo from "@spook/brand/assets/mini-logo.svg";
import { useGetMe } from "@spook/shared";
import { Link, useParams, useRouterState } from "@tanstack/react-router";
import { BellOff, LogOut, Plus, Settings, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { useSignOut } from "@/auth/use-sign-out";
import { useShell } from "@/components/shell";
import { ThemeToggle } from "@/components/theme-toggle";
import { avatarColor } from "@/components/ui/avatar";
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
import { cn } from "@/lib/utils";
import { AddServerDialog } from "./add-server-dialog";

/** Base dos ícones da barra: círculo que vira quadrado arredondado no hover/ativo (só `border-radius`, em caixa pequena). */
const itemBase =
  "relative flex size-12 items-center justify-center overflow-hidden text-sm font-semibold transition-[border-radius,background-color,color,filter] duration-[var(--dur-base)] ease-[var(--ease-out)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";
const shapeIdle = "rounded-[1.5rem] hover:rounded-[1rem]";
const shapeActive = "rounded-[1rem]";

/** Pílula lateral: alta no ativo, baixa no hover/foco, ponto nas não lidas. Só `transform` anima. */
function Pill({ state }: { state: "active" | "unread" | "none" }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute top-1/2 left-0 h-10 w-1 origin-center -translate-y-1/2 rounded-r-full bg-foreground transition-transform duration-[var(--dur-base)] ease-[var(--ease-out)]",
        state === "active"
          ? "scale-y-100"
          : state === "unread"
            ? "scale-y-[.2] group-focus-within:scale-y-50 group-hover:scale-y-50"
            : "scale-y-0 group-focus-within:scale-y-50 group-hover:scale-y-50",
      )}
    />
  );
}

function GuildButton({ guild: g, active }: { guild: Guild; active: boolean }) {
  const t = useGuildTotals(g.id);
  const muted = useIsMuted("guild", g.id);
  const shell = useShell();
  const [menu, setMenu] = useState(false);
  const colors = avatarColor(g.id);
  const hasUnread = !muted && (t.unread > 0 || t.mentions > 0);
  const label =
    t.mentions > 0
      ? `${g.name}, ${t.mentions > 99 ? "99+" : t.mentions} ${t.mentions === 1 ? "menção" : "menções"}`
      : hasUnread
        ? `${g.name}, mensagens novas`
        : g.name;
  return (
    <li
      className="group relative flex w-full justify-center"
      data-muted={muted || undefined}
      data-active={active || undefined}
      onContextMenu={(e) => {
        e.preventDefault(); // abre o mesmo menu do servidor (notificações), ancorado no ícone
        setMenu(true);
      }}
    >
      <Pill state={active ? "active" : hasUnread ? "unread" : "none"} />
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
      <div className="relative">
        <Tooltip>
          <TooltipTrigger asChild>
            <Link
              to="/channels/$guildId"
              params={{ guildId: g.id }}
              aria-label={label}
              onClick={() => shell?.holdNav()}
              style={
                g.icon_url
                  ? undefined
                  : { background: `linear-gradient(135deg, ${colors.from}, ${colors.to})` }
              }
              className={cn(
                itemBase,
                active ? shapeActive : shapeIdle,
                g.icon_url ? "bg-surface-3" : "text-white",
                muted && "opacity-50 saturate-50 hover:opacity-80",
              )}
              activeOptions={{ exact: false }}
            >
              {g.icon_url ? (
                <img src={g.icon_url} alt="" className="size-full object-cover" />
              ) : (
                <span aria-hidden>{initials(g.name)}</span>
              )}
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={14}>
            {g.name}
          </TooltipContent>
        </Tooltip>
        {t.mentions > 0 ? (
          <MentionBadge
            count={t.mentions}
            label={mentionLabel(t.mentions, g.name)}
            className="pointer-events-none absolute -right-1.5 -bottom-1.5 h-[1.125rem] min-w-[1.125rem] ring-[3px] ring-sidebar"
          />
        ) : muted ? (
          <BellOff
            role="img"
            aria-label="Servidor silenciado"
            className="pointer-events-none absolute -right-1 -bottom-1 size-[1.125rem] rounded-full bg-sidebar p-[3px] text-muted-foreground"
          />
        ) : null}
      </div>
    </li>
  );
}

export function ServerRail({ guilds }: { guilds: Guild[] }) {
  const [adding, setAdding] = useState(false);
  const { signOut, pending } = useSignOut();
  const dms = useDmTotals();
  const { data: me } = useGetMe();
  const shell = useShell();
  const params = useParams({ strict: false }) as { guildId?: string };
  const homeActive = useRouterState({
    select: (s) => s.location.pathname.startsWith("/channels/@me"),
  });
  const tool =
    "flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground";
  return (
    <nav
      aria-label="Servidores"
      className="flex w-[4.5rem] shrink-0 flex-col items-center gap-2 overflow-y-auto border-r bg-sidebar py-3 scrollbar-none"
    >
      <div className="group relative flex w-full justify-center">
        <Pill state={homeActive ? "active" : "none"} />
        <div className="relative">
          <Tooltip>
            <TooltipTrigger asChild>
              <Link
                to="/channels/@me"
                aria-label="Início"
                onClick={() => shell?.holdNav()}
                className={cn(
                  itemBase,
                  homeActive
                    ? `${shapeActive} bg-primary`
                    : `${shapeIdle} bg-surface-3 hover:bg-primary`,
                )}
              >
                <img src={miniLogo} alt="" className="size-8" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={14}>
              Início (mensagens diretas)
            </TooltipContent>
          </Tooltip>
          {dms.mentions > 0 ? (
            <MentionBadge
              count={dms.mentions}
              label={`${dms.mentions > 99 ? "99+" : dms.mentions} mensagens diretas não lidas`}
              className="pointer-events-none absolute -right-1.5 -bottom-1.5 h-[1.125rem] min-w-[1.125rem] ring-[3px] ring-sidebar"
            />
          ) : dms.unread > 0 ? (
            <UnreadDot
              label="Mensagens diretas novas"
              className="pointer-events-none absolute right-0 bottom-0 size-3 ring-[3px] ring-sidebar"
            />
          ) : null}
        </div>
      </div>
      <hr className="mx-auto h-0.5 w-8 shrink-0 rounded-full border-0 bg-border" />
      <ul className="flex w-full flex-col items-center gap-2">
        {guilds.map((g) => (
          <GuildButton key={g.id} guild={g} active={params.guildId === g.id} />
        ))}
      </ul>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="Adicionar um servidor"
            onClick={() => setAdding(true)}
            className={cn(
              itemBase,
              shapeIdle,
              "bg-surface-3 text-success-text hover:bg-success hover:text-success-foreground",
            )}
          >
            <Plus className="size-6" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={14}>
          Criar servidor ou entrar com convite
        </TooltipContent>
      </Tooltip>
      <div className="mt-auto flex flex-col items-center gap-1 pt-2">
        {me?.is_admin ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Link to="/admin" aria-label="Painel de administração" className={tool}>
                <ShieldCheck className="size-5" />
              </Link>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={14}>
              Painel de administração
            </TooltipContent>
          </Tooltip>
        ) : null}
        <Tooltip>
          <TooltipTrigger asChild>
            <Link to="/settings/profile" aria-label="Configurações do perfil" className={tool}>
              <Settings className="size-5" />
            </Link>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={14}>
            Perfil
          </TooltipContent>
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
