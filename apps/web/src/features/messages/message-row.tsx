import type { MessagePayload } from "@spook/shared";
import {
  Ban,
  Copy,
  Hash,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Trash2,
  UserPlus,
} from "lucide-react";
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
import { shownName } from "@/features/account/removed-user";
import { MessageAttachments } from "@/features/attachments/message-attachments";
import { useIsBlocked } from "@/features/social/store";
import { t, useT } from "@/i18n";
import { formatClock, formatFullDate, formatMessageTime } from "@/lib/format";
import { bulkMentionsMe, type MentionContext } from "@/lib/mentions";
import { useReadableRoleColor } from "@/lib/role-color";
import { tRich } from "@/lib/t-rich";
import { InviteCards } from "./invite-card";
import { MAX_MESSAGE_LENGTH, runeCount } from "./limits";

export type MessageRowProps = {
  message: MessagePayload;
  header: boolean;
  day?: string;
  /** Mostra a linha "Novas mensagens" acima. */
  marker?: boolean;
  color?: string;
  /** Apelido do autor neste servidor (vence o nome de exibição). */
  nickname?: string;
  /** Quem está logado: a mensagem que o cita ganha destaque. */
  myId: string;
  myUsername: string;
  /** Usernames (minúsculos) que podem ser citados na conversa: ganham a pílula de menção. */
  mentionable?: ReadonlySet<string>;
  /** Cargos do servidor e os meus: `@everyone`, `@here` e `@cargo` ganham pílula e destacam a linha. */
  mentionCtx?: MentionContext;
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
    toast.error(t("chat.row.copyFailed"));
  }
}

export const MessageRow = memo(function MessageRow(p: MessageRowProps) {
  const { t } = useT();
  const { message: m } = p;
  const name = p.nickname || shownName(m.author.display_name, m.author.username);
  const nameColor = useReadableRoleColor(p.color);
  // mention_ids traz quem deve ser NOTIFICADO (o servidor exclui o próprio autor). Só ele destaca a linha;
  // o "@usuário" no texto é destacado sempre que cita você, inclusive numa mensagem sua.
  const mentionsMe =
    (m.mention_ids ?? []).includes(p.myId) || bulkMentionsMe(m, p.myId, p.mentionCtx);
  const [touchMenu, setTouchMenu] = useState(false);
  // Mensagens de quem eu bloqueei ficam recolhidas (a menos que eu peça para ver, só nesta linha).
  const blocked = useIsBlocked(m.author.id);
  const [revealed, setRevealed] = useState(false);
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
        aria-label={t("chat.row.viewProfile", { name })}
        onClick={(e) => p.onOpenProfile?.(m.author.id, e.currentTarget)}
        className={className}
      >
        {child}
      </button>
    ) : (
      <span className={className}>{child}</span>
    );

  if (m.kind === "member_join")
    return (
      <>
        {p.marker ? <NewMessagesDivider /> : null}
        {p.day ? <DayDivider label={p.day} /> : null}
        <JoinRow name={name} at={m.created_at} />
      </>
    );

  if (blocked && !revealed && m.author.id !== p.myId)
    return (
      <>
        {p.marker ? <NewMessagesDivider /> : null}
        {p.day ? <DayDivider label={p.day} /> : null}
        <article
          aria-label={t("chat.row.blockedAria")}
          className="flex items-center gap-2 px-4 py-1.5 text-xs text-muted-foreground"
        >
          <Ban aria-hidden className="size-3.5 shrink-0" />
          <span>{t("chat.row.blockedMessage")}</span>
          <button
            type="button"
            onClick={() => setRevealed(true)}
            className="rounded-sm font-medium text-brand-text underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
          >
            {t("chat.row.show")}
          </button>
        </article>
      </>
    );

  return (
    <>
      {p.marker ? <NewMessagesDivider /> : null}
      {p.day ? <DayDivider label={p.day} /> : null}
      <article
        aria-label={t("chat.row.messageFrom", { name })}
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
                      ? highlightMentions(
                          m.content,
                          p.myUsername,
                          p.mentionable,
                          bulkOf(m, p.mentionCtx),
                        )
                      : m.content}
                    {m.edited_at ? (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span
                            // biome-ignore lint/a11y/noNoninteractiveTabindex: o foco mostra a data pelo teclado
                            tabIndex={0}
                            className="ml-1 cursor-default rounded-sm text-2xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {t("chat.row.edited")}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                          {t("chat.row.editedAt", { date: formatFullDate(m.edited_at) })}
                        </TooltipContent>
                      </Tooltip>
                    ) : null}
                  </p>
                ) : null}
                {m.content ? <InviteCards content={m.content} /> : null}
                <MessageAttachments attachments={m.attachments ?? []} />
              </>
            )}
          </div>
        </div>
        {hasActions ? (
          <>
            <div
              role="toolbar"
              aria-label={t("chat.row.actions")}
              className={`invisible pointer-events-none absolute -top-4 right-4 z-[var(--z-sticky)] flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 opacity-0 shadow-md transition-opacity duration-[var(--dur-fast)] group-focus-within/msg:visible group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100 group-hover/msg:visible group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 has-[[data-state=open]]:visible has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 [@media(hover:none)]:hidden max-md:hidden`}
            >
              {p.canReply ? (
                <ActionButton label={t("chat.row.reply")} kbd="R" onClick={() => p.onReply(m)}>
                  <Reply />
                </ActionButton>
              ) : null}
              {p.canPin ? (
                <ActionButton
                  label={m.pinned ? t("chat.row.unpinMessage") : t("chat.row.pinMessage")}
                  tip={m.pinned ? t("chat.row.unpin") : t("chat.row.pin")}
                  kbd="P"
                  onClick={() => p.onTogglePin(m)}
                >
                  {m.pinned ? <PinOff /> : <Pin />}
                </ActionButton>
              ) : null}
              {p.canEdit ? (
                <ActionButton
                  label={t("chat.row.editMessage")}
                  tip={t("chat.row.edit")}
                  kbd="E"
                  onClick={() => p.onStartEdit(m.id)}
                >
                  <Pencil />
                </ActionButton>
              ) : null}
              {p.canDelete ? (
                <ActionButton
                  label={t("chat.row.deleteMessage")}
                  tip={t("chat.row.delete")}
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
                        aria-label={t("chat.row.moreActions")}
                      >
                        <MoreHorizontal />
                      </Button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t("chat.row.more")}</TooltipContent>
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
                    aria-label={t("chat.row.actionsOf", { name })}
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
  const { t } = useT();
  return (
    <Badge variant="brand" className="text-2xs">
      <Pin role="img" aria-label={t("chat.row.pinnedMessage")} />
      {t("chat.row.pinned")}
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
  const { t } = useT();
  return (
    <div className="flex items-center gap-3 px-4 pt-3 pb-1">
      <hr aria-hidden className="flex-1 border-destructive/60" />
      <span className="rounded-full bg-danger-soft px-3 py-0.5 text-xs font-semibold text-destructive-text">
        {t("chat.row.newMessages")}
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
  const { t } = useT();
  return (
    <DropdownMenuContent align="end" className="min-w-52">
      {full && p.canReply ? (
        <DropdownMenuItem onSelect={() => p.onReply(m)}>
          <Reply /> {t("chat.row.reply")}
        </DropdownMenuItem>
      ) : null}
      {full && p.canPin ? (
        <DropdownMenuItem onSelect={() => p.onTogglePin(m)}>
          {m.pinned ? <PinOff /> : <Pin />} {m.pinned ? t("chat.row.unpin") : t("chat.row.pin")}
        </DropdownMenuItem>
      ) : null}
      {full && p.canEdit ? (
        <DropdownMenuItem onSelect={() => p.onStartEdit(m.id)}>
          <Pencil /> {t("chat.row.edit")}
        </DropdownMenuItem>
      ) : null}
      {m.content ? (
        <DropdownMenuItem onSelect={() => void copyText(m.content, t("chat.row.textCopied"))}>
          <Copy /> {t("chat.row.copyText")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem onSelect={() => void copyText(m.id, t("chat.row.idCopied"))}>
        <Hash /> {t("chat.row.copyId")}
      </DropdownMenuItem>
      {full && p.canDelete ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem destructive onSelect={() => p.onDelete(m)}>
            <Trash2 /> {t("chat.row.delete")}
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
  const { t } = useT();
  const author = shownName(reply.author.display_name, reply.author.username);
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
        <span>{t("chat.row.originalDeleted")}</span>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 items-center gap-2 pt-2">
      {connector}
      <button
        type="button"
        aria-label={t("chat.row.jumpToOriginal", { name: author })}
        onClick={() => onJumpTo(reply.id)}
        className="flex min-w-0 max-w-full items-center gap-1.5 rounded-md px-1 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:text-foreground"
      >
        <Avatar name={author} seed={reply.author.id} size={16} />
        <span className="shrink-0 font-medium text-foreground/80">@{author}</span>
        <span className="truncate">
          {reply.content || (reply.has_attachments ? t("chat.row.attachment") : "")}
          {reply.content && reply.has_attachments ? ` ${t("chat.row.withAttachment")}` : ""}
        </span>
      </button>
    </div>
  );
}

/** Destaca o `@username` do usuário no texto (sem diferenciar maiúsculas), só onde é uma menção de verdade. */
export function highlightMention(content: string, username: string): ReactNode[] {
  return highlightMentions(content, username);
}

/** Menções em massa que esta mensagem realmente faz (as que o servidor aceitou) e os cargos citados. */
export type BulkHighlight = {
  everyone: boolean;
  here: boolean;
  roles: readonly { id: string; name: string; color?: string }[];
};

/** O que a mensagem marcou como menção em massa; `undefined` se nada (o texto `@everyone` fica comum). */
export function bulkOf(m: MessagePayload, ctx?: MentionContext): BulkHighlight | undefined {
  const ids = new Set(m.mention_roles ?? []);
  if (!m.mention_everyone && !m.mention_here && ids.size === 0) return undefined;
  return {
    everyone: !!m.mention_everyone,
    here: !!m.mention_here,
    roles: (ctx?.roles ?? []).filter((r) => ids.has(r.id)),
  };
}

const NO_LEAD = /[A-Za-z0-9_.@]/;
const WORDISH = /[\p{L}\p{N}_@]/u;
const USER_TOKEN = /^[A-Za-z0-9_.]+/;

/** O que vem depois da menção a encerra? (fim do texto, espaço ou pontuação.) */
function endsToken(content: string, at: number): boolean {
  if (at >= content.length) return true;
  const cp = content.codePointAt(at);
  return cp === undefined || !WORDISH.test(String.fromCodePoint(cp));
}

/** Pílula de cargo: o texto usa a cor do cargo ajustada ao tema (contraste AA) sobre um fundo suave da mesma cor. */
function RolePill({ name, color }: { name: string; color?: string }) {
  const text = useReadableRoleColor(color);
  return (
    <mark
      data-mention-pill="role"
      className="rounded-sm bg-brand-500/12 px-1 font-medium text-brand-text"
      style={text && color ? { color: text, backgroundColor: `${color}1f` } : undefined}
    >
      @{name}
    </mark>
  );
}

/**
 * Transforma menções em pílulas: a minha `@usuário` ganha realce forte; as de quem está na conversa (`known`,
 * usernames em minúsculas) ganham a pílula suave; `@everyone`/`@here` (se a mensagem realmente os marcou) e
 * `@NomeDoCargo` (cargos que ela marcou) ganham pílula própria. Mesma regra do servidor: o @ não pode vir colado
 * a letra, dígito, _, . ou @, e o nome termina onde acaba o token (o nome de cargo pode ter espaços).
 */
export function highlightMentions(
  content: string,
  username: string,
  known?: ReadonlySet<string>,
  bulk?: BulkHighlight,
): ReactNode[] {
  const me = username.toLowerCase();
  const roles = bulk ? [...bulk.roles].sort((a, b) => b.name.length - a.name.length) : [];
  const out: ReactNode[] = [];
  let last = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charAt(i) !== "@") continue;
    if (i > 0 && NO_LEAD.test(content.charAt(i - 1))) continue;
    const rest = content.slice(i + 1);
    const lower = rest.toLowerCase();
    let end = -1;
    let node: ReactNode = null;

    for (const word of ["everyone", "here"] as const) {
      if (bulk?.[word] && lower.startsWith(word) && endsToken(content, i + 1 + word.length)) {
        end = i + 1 + word.length;
        node = (
          <mark
            key={i}
            data-mention-pill="everyone"
            className="rounded-sm bg-brand-500/25 px-1 font-medium text-brand-text"
          >
            @{word}
          </mark>
        );
        break;
      }
    }
    if (!node) {
      for (const role of roles) {
        const n = role.name.length;
        if (n > 0 && lower.startsWith(role.name.toLowerCase()) && endsToken(content, i + 1 + n)) {
          end = i + 1 + n;
          node = <RolePill key={i} name={rest.slice(0, n)} color={role.color} />;
          break;
        }
      }
    }
    if (!node) {
      const raw = USER_TOKEN.exec(rest)?.[0] ?? "";
      // O nome de usuário pode ter ponto no meio, mas ponto no fim é pontuação da frase.
      const token = raw.replace(/\.+$/, "");
      const isMe = !!me && token.toLowerCase() === me;
      const after = i + 1 + raw.length;
      if (token && (isMe || known?.has(token.toLowerCase())) && endsToken(content, after)) {
        end = i + 1 + token.length;
        node = (
          <mark
            key={i}
            data-mention-pill={isMe ? "me" : "other"}
            className={`rounded-sm px-1 font-medium text-brand-text ${isMe ? "bg-brand-500/25" : "bg-brand-500/12"}`}
          >
            @{token}
          </mark>
        );
      }
    }
    if (!node) continue;
    if (i > last) out.push(content.slice(last, i));
    out.push(node);
    last = end;
    i = end - 1;
  }
  if (last < content.length) out.push(content.slice(last));
  return out.length > 0 ? out : [content];
}

/** Mensagem de sistema "fulano entrou no servidor": linha centralizada, sem avatar nem ações. */
function JoinRow({ name, at }: { name: string; at: string }) {
  const { t } = useT();
  return (
    <article
      aria-label={t("chat.row.joinedAria", { name })}
      data-system="member_join"
      className="flex items-center justify-center gap-2 px-4 py-2 text-sm text-muted-foreground"
    >
      <UserPlus className="size-4 shrink-0 text-brand-text" aria-hidden />
      <p className="min-w-0 text-center break-words">
        {tRich(
          t,
          "chat.row.joined",
          "name",
          <strong className="font-medium text-foreground">{name}</strong>,
        )}
      </p>
      <time dateTime={at} title={formatFullDate(at)} className="shrink-0 text-2xs tabular">
        {formatMessageTime(at)}
      </time>
    </article>
  );
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
  const { t } = useT();
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
        aria-label={t("chat.row.editMessage")}
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
        {t("chat.row.editHint")}{" "}
        {length > MAX_MESSAGE_LENGTH ? (
          <span className="text-destructive-text">
            {t("chat.row.tooLong", { max: MAX_MESSAGE_LENGTH })}
          </span>
        ) : null}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void save()} loading={saving} disabled={invalid}>
          {t("chat.row.save")}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          {t("chat.row.cancel")}
        </Button>
      </div>
    </div>
  );
}
