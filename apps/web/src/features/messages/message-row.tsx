import type { MessagePayload } from "@spook/shared";
import { Copy, Hash, MoreHorizontal, Pencil, Pin, PinOff, Reply, Trash2 } from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { Avatar } from "@/components/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/kbd";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { MessageAttachments } from "@/features/attachments/message-attachments";
import { formatClock, formatFullDate, formatMessageTime } from "@/lib/format";
import { useReadableRoleColor } from "@/lib/role-color";
import { MAX_MESSAGE_LENGTH, runeCount } from "./limits";

export type MessageRowProps = {
  message: MessagePayload;
  header: boolean;
  day?: string;
  /** Mostra a linha "Novas mensagens" acima. */
  marker?: boolean;
  color?: string;
  /** Quem está logado: a mensagem que o cita ganha destaque. */
  myId: string;
  myUsername: string;
  /** Usernames (minúsculos) que podem ser citados na conversa: ganham a pílula de menção. */
  mentionable?: ReadonlySet<string>;
  canEdit: boolean;
  canDelete: boolean;
  /** Pode responder (SEND_MESSAGES no servidor; sempre em DM). */
  canReply: boolean;
  /** Pode fixar/desafixar (MANAGE_MESSAGES no servidor; qualquer participante em DM). */
  canPin: boolean;
  editing: boolean;
  /** Linha destacada um instante depois de "ir até a mensagem". */
  highlighted?: boolean;
  /** É a mensagem a que o composer está respondendo agora. */
  replyTarget?: boolean;
  onReply: (message: MessagePayload) => void;
  onTogglePin: (message: MessagePayload) => void;
  /** Clique na citação: rola até a mensagem original (carregando páginas anteriores se preciso). */
  onJumpTo: (messageId: string) => void;
  onStartEdit: (id: string) => void;
  onCancelEdit: () => void;
  onSaveEdit: (id: string, content: string) => Promise<void>;
  onDelete: (message: MessagePayload) => void;
  /** Abre o cartão de perfil do autor (clique no nome ou no avatar). */
  onOpenProfile?: (userId: string, trigger: HTMLElement) => void;
};

const LONG_PRESS_MS = 450;

async function copyText(text: string, done: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch {
    toast.error("Não foi possível copiar.");
  }
}

export const MessageRow = memo(function MessageRow(p: MessageRowProps) {
  const { message: m } = p;
  const name = m.author.display_name || m.author.username;
  const nameColor = useReadableRoleColor(p.color);
  // mention_ids traz quem deve ser NOTIFICADO (o servidor exclui o próprio autor). Só ele destaca a linha;
  // o "@usuário" no texto é destacado sempre que cita você, inclusive numa mensagem sua.
  const mentionsMe = (m.mention_ids ?? []).includes(p.myId);
  const [touchMenu, setTouchMenu] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout>>(undefined);
  const hasActions = !p.editing && (p.canEdit || p.canDelete || p.canReply || p.canPin);

  // Toque longo (só dedo, não mouse) abre o mesmo menu do botão "⋯".
  function startPress(e: PointerEvent<HTMLElement>) {
    if (e.pointerType !== "touch" || !hasActions) return;
    clearTimeout(press.current);
    press.current = setTimeout(() => setTouchMenu(true), LONG_PRESS_MS);
  }
  const endPress = () => clearTimeout(press.current);

  // Atalhos com a própria mensagem focada (Tab/clique): R responde, P fixa, E edita.
  function onKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey || e.altKey || p.editing) return;
    const key = e.key.toLowerCase();
    if (key === "r" && p.canReply) p.onReply(m);
    else if (key === "p" && p.canPin) p.onTogglePin(m);
    else if (key === "e" && p.canEdit) p.onStartEdit(m.id);
    else return;
    e.preventDefault();
  }

  const profileButton = (child: ReactNode, className?: string) =>
    p.onOpenProfile ? (
      <button
        type="button"
        aria-label={`Ver perfil de ${name}`}
        onClick={(e) => p.onOpenProfile?.(m.author.id, e.currentTarget)}
        className={className}
      >
        {child}
      </button>
    ) : (
      <span className={className}>{child}</span>
    );

  return (
    <>
      {p.marker ? <NewMessagesDivider /> : null}
      {p.day ? <DayDivider label={p.day} /> : null}
      <article
        aria-label={`Mensagem de ${name}`}
        aria-keyshortcuts="R P E"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a mensagem recebe foco para revelar as ações e aceitar os atalhos (R, P, E)
        tabIndex={0}
        onKeyDown={onKeyDown}
        onPointerDown={startPress}
        onPointerUp={endPress}
        onPointerMove={endPress}
        onPointerCancel={endPress}
        data-mention={mentionsMe || undefined}
        data-pinned={m.pinned || undefined}
        data-highlighted={p.highlighted || undefined}
        data-header={p.header || undefined}
        className={`group/msg relative flex flex-col px-4 outline-none transition-colors duration-[var(--dur-base)] hover:bg-accent/40 focus-within:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset [@media(hover:none)]:pr-12 max-md:pr-12 ${
          mentionsMe
            ? "bg-brand-500/10 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary hover:bg-brand-500/15"
            : ""
        } ${p.highlighted ? "bg-brand-500/25" : ""} ${p.replyTarget ? "bg-accent/70" : ""}`}
      >
        {m.reply_to ? <ReplyQuote reply={m.reply_to} onJumpTo={p.onJumpTo} /> : null}
        <div className={p.header ? "flex gap-3 pt-2 pb-0.5" : "flex gap-3 py-px"}>
          <div className="w-10 shrink-0 pt-0.5 text-right">
            {p.header ? (
              profileButton(
                <Avatar
                  url={m.author.avatar_url}
                  name={name}
                  seed={m.author.id}
                  size={40}
                  className="transition-opacity hover:opacity-90"
                />,
                "block rounded-full",
              )
            ) : (
              <time
                dateTime={m.created_at}
                title={formatFullDate(m.created_at)}
                className="text-2xs leading-6 text-muted-foreground opacity-0 transition-opacity group-focus-within/msg:opacity-100 group-hover/msg:opacity-100"
              >
                {formatClock(m.created_at)}
              </time>
            )}
          </div>
          <div className="min-w-0 flex-1">
            {p.header ? (
              <div className="flex flex-wrap items-baseline gap-x-2">
                {profileButton(
                  <span
                    className="text-sm font-semibold hover:underline"
                    style={nameColor ? { color: nameColor } : undefined}
                  >
                    {name}
                  </span>,
                  "rounded-sm text-left",
                )}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <time
                      dateTime={m.created_at}
                      className="text-2xs tabular text-muted-foreground"
                    >
                      {formatMessageTime(m.created_at)}
                    </time>
                  </TooltipTrigger>
                  <TooltipContent side="top">{formatFullDate(m.created_at)}</TooltipContent>
                </Tooltip>
                {m.pinned ? <PinnedBadge /> : null}
              </div>
            ) : m.pinned ? (
              <PinnedBadge />
            ) : null}
            {p.editing ? (
              <EditBox
                initial={m.content}
                onCancel={p.onCancelEdit}
                onSave={(c) => p.onSaveEdit(m.id, c)}
              />
            ) : (
              <>
                {m.content ? (
                  <p className="text-sm leading-6 break-words whitespace-pre-wrap">
                    {m.content.includes("@")
                      ? highlightMentions(m.content, p.myUsername, p.mentionable)
                      : m.content}
                    {m.edited_at ? (
                      <span
                        className="ml-1 text-2xs text-muted-foreground"
                        title={`Editada em ${formatFullDate(m.edited_at)}`}
                      >
                        (editada)
                      </span>
                    ) : null}
                  </p>
                ) : null}
                <MessageAttachments attachments={m.attachments ?? []} />
              </>
            )}
          </div>
        </div>
        {hasActions ? (
          <>
            <div
              role="toolbar"
              aria-label="Ações da mensagem"
              className={`invisible pointer-events-none absolute -top-4 right-4 z-[var(--z-sticky)] flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 opacity-0 shadow-md transition-opacity duration-[var(--dur-fast)] group-focus-within/msg:visible group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-hover/msg:visible group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 has-[[data-state=open]]:visible has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 [@media(hover:none)]:hidden max-md:hidden`}
            >
              {p.canReply ? (
                <ActionButton label="Responder" kbd="R" onClick={() => p.onReply(m)}>
                  <Reply />
                </ActionButton>
              ) : null}
              {p.canPin ? (
                <ActionButton
                  label={m.pinned ? "Desafixar mensagem" : "Fixar mensagem"}
                  tip={m.pinned ? "Desafixar" : "Fixar"}
                  kbd="P"
                  onClick={() => p.onTogglePin(m)}
                >
                  {m.pinned ? <PinOff /> : <Pin />}
                </ActionButton>
              ) : null}
              {p.canEdit ? (
                <ActionButton
                  label="Editar mensagem"
                  tip="Editar"
                  kbd="E"
                  onClick={() => p.onStartEdit(m.id)}
                >
                  <Pencil />
                </ActionButton>
              ) : null}
              {p.canDelete ? (
                <ActionButton
                  label="Excluir mensagem"
                  tip="Excluir"
                  destructive
                  onClick={() => p.onDelete(m)}
                >
                  <Trash2 />
                </ActionButton>
              ) : null}
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        className="size-7"
                        aria-label="Mais ações"
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">Mais</TooltipContent>
                </Tooltip>
                <MessageMenu full={false} {...p} />
              </DropdownMenu>
            </div>
            {/* Telas sem hover: botão sempre visível (toque longo na mensagem abre o mesmo menu). */}
            <div
              className={`absolute top-1 right-2 hidden [@media(hover:none)]:block max-md:block`}
            >
              <DropdownMenu open={touchMenu} onOpenChange={setTouchMenu}>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 text-muted-foreground"
                    aria-label={`Ações da mensagem de ${name}`}
                  >
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <MessageMenu full {...p} />
              </DropdownMenu>
            </div>
          </>
        ) : null}
      </article>
    </>
  );
});

function PinnedBadge() {
  return (
    <Badge variant="brand" className="text-2xs">
      <Pin role="img" aria-label="Mensagem fixada" />
      Fixada
    </Badge>
  );
}

/** Linha de início de dia: pílula discreta no meio de duas linhas. */
export function DayDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-3 px-4 pt-4 pb-2">
      <hr aria-label={label} className="flex-1 border-border" />
      <span
        aria-hidden
        className="rounded-full border border-border bg-surface-1 px-3 py-0.5 text-xs font-medium text-muted-foreground"
      >
        {label}
      </span>
      <hr aria-hidden className="flex-1 border-border" />
    </div>
  );
}

/** "Novas mensagens": linha + pílula na cor de perigo suave (o mesmo vermelho dos contadores de menção). */
export function NewMessagesDivider() {
  return (
    <div className="flex items-center gap-3 px-4 pt-3 pb-1">
      <hr aria-hidden className="flex-1 border-destructive/60" />
      <span className="rounded-full bg-danger-soft px-3 py-0.5 text-xs font-semibold text-destructive-text">
        Novas mensagens
      </span>
      <hr aria-hidden className="flex-1 border-destructive/60" />
    </div>
  );
}

function ActionButton({
  label,
  tip,
  kbd,
  destructive,
  onClick,
  children,
}: {
  label: string;
  tip?: string;
  kbd?: string;
  destructive?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          className={`size-7 ${destructive ? "text-destructive-text hover:bg-danger-soft" : ""}`}
          aria-label={label}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="flex items-center gap-1.5">
        {tip ?? label}
        {kbd ? (
          <Kbd className="border-background/30 bg-background/15 text-background">{kbd}</Kbd>
        ) : null}
      </TooltipContent>
    </Tooltip>
  );
}

/** Menu da mensagem: `full` (toque) repete as ações da barra; sempre tem copiar texto e ID. */
function MessageMenu({
  message: m,
  full,
  ...p
}: MessageRowProps & { message: MessagePayload; full: boolean }) {
  return (
    <DropdownMenuContent align="end" className="min-w-52">
      {full && p.canReply ? (
        <DropdownMenuItem onSelect={() => p.onReply(m)}>
          <Reply /> Responder
        </DropdownMenuItem>
      ) : null}
      {full && p.canPin ? (
        <DropdownMenuItem onSelect={() => p.onTogglePin(m)}>
          {m.pinned ? <PinOff /> : <Pin />} {m.pinned ? "Desafixar" : "Fixar"}
        </DropdownMenuItem>
      ) : null}
      {full && p.canEdit ? (
        <DropdownMenuItem onSelect={() => p.onStartEdit(m.id)}>
          <Pencil /> Editar
        </DropdownMenuItem>
      ) : null}
      {m.content ? (
        <DropdownMenuItem onSelect={() => void copyText(m.content, "Texto copiado.")}>
          <Copy /> Copiar texto
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => void copyText(m.id, "ID da mensagem copiado.")}>
        <Hash /> Copiar ID da mensagem
      </DropdownMenuItem>
      {full && p.canDelete ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => p.onDelete(m)}>
            <Trash2 /> Excluir
          </DropdownMenuItem>
        </>
      ) : null}
    </DropdownMenuContent>
  );
}

/** Citação da mensagem respondida acima da resposta: curva até o avatar, avatar mini, nome e prévia. */
function ReplyQuote({
  reply,
  onJumpTo,
}: {
  reply: NonNullable<MessagePayload["reply_to"]>;
  onJumpTo: (messageId: string) => void;
}) {
  const author = reply.author.display_name || reply.author.username;
  const connector = (
    <span
      aria-hidden
      className="mt-2 ml-5 h-3 w-8 shrink-0 self-end rounded-tl-lg border-t-2 border-l-2 border-border"
    />
  );
  if (reply.deleted) {
    return (
      <div className="flex items-center gap-2 pt-2 text-xs text-muted-foreground italic">
        {connector}
        <span>Mensagem original apagada</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 pt-2">
      {connector}
      <button
        type="button"
        aria-label={`Ir para a mensagem original de ${author}`}
        onClick={() => onJumpTo(reply.id)}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-foreground"
      >
        <Avatar name={author} seed={reply.author.id} size={16} />
        <span className="shrink-0 font-medium text-foreground/80">@{author}</span>
        <span className="truncate">
          {reply.content || (reply.has_attachments ? "Anexo" : "")}
          {reply.content && reply.has_attachments ? " (com anexo)" : ""}
        </span>
      </button>
    </div>
  );
}

/** Destaca o `@username` do usuário no texto (sem diferenciar maiúsculas), só onde é uma menção de verdade. */
export function highlightMention(content: string, username: string): ReactNode[] {
  return highlightMentions(content, username);
}

/**
 * Transforma `@usuário` em pílula: a minha menção ganha realce forte; as de quem está na conversa (`known`,
 * usernames em minúsculas) ganham a pílula suave. Mesma regra do servidor: o @ não pode vir colado a letra,
 * dígito, _, . ou @, e o nome termina onde acaba o token.
 */
export function highlightMentions(
  content: string,
  username: string,
  known?: ReadonlySet<string>,
): ReactNode[] {
  const me = username.toLowerCase();
  const re = /(^|[^A-Za-z0-9_.@])@([A-Za-z0-9_.]+)/g;
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(re)) {
    const lead = match[1]?.length ?? 0;
    const start = (match.index ?? 0) + lead;
    const raw = match[2] ?? "";
    // O nome de usuário pode ter ponto no meio, mas ponto no fim é pontuação da frase.
    const token = raw.replace(/\.+$/, "");
    const lower = token.toLowerCase();
    const isMe = !!me && lower === me;
    if (!isMe && !known?.has(lower)) continue;
    if (start > last) out.push(content.slice(last, start));
    out.push(
      <mark
        key={start}
        data-mention-pill={isMe ? "me" : "other"}
        className={`rounded-sm px-1 font-medium text-brand-text ${isMe ? "bg-brand-500/25" : "bg-brand-500/12"}`}
      >
        @{token}
      </mark>,
    );
    last = start + 1 + token.length;
  }
  if (last < content.length) out.push(content.slice(last));
  return out.length > 0 ? out : [content];
}

function EditBox({
  initial,
  onSave,
  onCancel,
}: {
  initial: string;
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const length = runeCount(value);
  const invalid = value.trim().length === 0 || length > MAX_MESSAGE_LENGTH;

  async function save() {
    if (invalid || saving) return;
    if (value.trim() === initial) return onCancel();
    setSaving(true);
    try {
      await onSave(value);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5 py-1">
      <Textarea
        autoFocus
        aria-label="Editar mensagem"
        value={value}
        maxLength={MAX_MESSAGE_LENGTH * 2}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className="field-sizing-content max-h-48"
      />
      <p className="text-xs text-muted-foreground">
        Enter para salvar, Esc para cancelar.{" "}
        {length > MAX_MESSAGE_LENGTH ? (
          <span className="text-destructive-text">Passou de {MAX_MESSAGE_LENGTH} caracteres.</span>
        ) : null}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={invalid}>
          Salvar
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
