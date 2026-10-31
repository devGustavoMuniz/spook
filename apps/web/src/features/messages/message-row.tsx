import type { MessagePayload } from "@spook/shared";
import { CornerUpRight, Pencil, Pin, PinOff, Reply, Trash2 } from "lucide-react";
import { type KeyboardEvent, memo, type ReactNode, useState } from "react";
import { Avatar } from "@/components/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { MessageAttachments } from "@/features/attachments/message-attachments";
import { formatClock, formatMessageTime } from "@/lib/format";
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
};

export const MessageRow = memo(function MessageRow(p: MessageRowProps) {
  const { message: m } = p;
  const name = m.author.display_name || m.author.username;
  // mention_ids traz quem deve ser NOTIFICADO (o servidor exclui o próprio autor). Só ele destaca a linha;
  // o "@usuário" no texto é destacado sempre que cita você, inclusive numa mensagem sua.
  const mentionsMe = (m.mention_ids ?? []).includes(p.myId);
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
  return (
    <article
      aria-label={`Mensagem de ${name}`}
      aria-keyshortcuts="R P E"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a mensagem recebe foco para revelar as ações e aceitar os atalhos (R, P, E)
      tabIndex={0}
      onKeyDown={onKeyDown}
      data-mention={mentionsMe || undefined}
      data-pinned={m.pinned || undefined}
      data-highlighted={p.highlighted || undefined}
      className={`group relative flex flex-col px-4 outline-none hover:bg-accent/40 focus-within:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset ${
        mentionsMe ? "border-l-2 border-primary bg-primary/10" : ""
      } ${p.highlighted ? "bg-primary/20 transition-colors" : ""} ${
        p.replyTarget ? "bg-accent/60" : ""
      }`}
    >
      {p.marker ? (
        <div className="flex items-center gap-3 pt-2 text-xs font-semibold text-destructive-text">
          <hr className="flex-1 border-destructive" />
          <span>Novas mensagens</span>
          <hr className="flex-1 border-destructive" />
        </div>
      ) : null}
      {p.day ? (
        <div className="flex items-center gap-3 py-3 text-xs text-muted-foreground">
          <hr className="flex-1 border-border" />
          <span>{p.day}</span>
          <hr className="flex-1 border-border" />
        </div>
      ) : null}
      {m.reply_to ? <ReplyQuote reply={m.reply_to} onJumpTo={p.onJumpTo} /> : null}
      <div className={p.header ? "flex gap-3 pt-2 pb-0.5" : "flex gap-3"}>
        <div className="w-10 shrink-0 pt-0.5 text-right text-[10px] text-muted-foreground">
          {p.header ? (
            <Avatar url={m.author.avatar_url} name={name} size={40} />
          ) : (
            <time
              dateTime={m.created_at}
              className="hidden leading-6 group-hover:inline"
              title={formatMessageTime(m.created_at)}
            >
              {formatClock(m.created_at)}
            </time>
          )}
        </div>
        <div className="min-w-0 flex-1">
          {p.header ? (
            <div className="flex items-baseline gap-2">
              <span className="font-medium" style={p.color ? { color: p.color } : undefined}>
                {name}
              </span>
              <time dateTime={m.created_at} className="text-xs text-muted-foreground">
                {formatMessageTime(m.created_at)}
              </time>
            </div>
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
                  {m.content.includes("@") ? highlightMention(m.content, p.myUsername) : m.content}
                  {m.edited_at ? (
                    <span
                      className="ml-1 text-[11px] text-muted-foreground"
                      title="Mensagem editada"
                    >
                      (editada)
                    </span>
                  ) : null}
                </p>
              ) : null}
              <MessageAttachments attachments={m.attachments ?? []} />
              {m.pinned ? (
                <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
                  <Pin className="size-3" role="img" aria-label="Mensagem fixada" />
                  fixada
                </p>
              ) : null}
            </>
          )}
        </div>
      </div>
      {!p.editing && (p.canEdit || p.canDelete || p.canReply || p.canPin) ? (
        <div className="absolute -top-3 right-4 hidden gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
          {p.canReply ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Responder"
              title="Responder (R)"
              onClick={() => p.onReply(m)}
            >
              <Reply />
            </Button>
          ) : null}
          {p.canPin ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={m.pinned ? "Desafixar mensagem" : "Fixar mensagem"}
              title={m.pinned ? "Desafixar (P)" : "Fixar (P)"}
              onClick={() => p.onTogglePin(m)}
            >
              {m.pinned ? <PinOff /> : <Pin />}
            </Button>
          ) : null}
          {p.canEdit ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label="Editar mensagem"
              onClick={() => p.onStartEdit(m.id)}
            >
              <Pencil />
            </Button>
          ) : null}
          {p.canDelete ? (
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-destructive-text"
              aria-label="Excluir mensagem"
              onClick={() => p.onDelete(m)}
            >
              <Trash2 />
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
});

/** Citação da mensagem respondida acima da resposta (autor + trecho). */
function ReplyQuote({
  reply,
  onJumpTo,
}: {
  reply: NonNullable<MessagePayload["reply_to"]>;
  onJumpTo: (messageId: string) => void;
}) {
  const author = reply.author.display_name || reply.author.username;
  if (reply.deleted) {
    return (
      <div className="ml-[52px] flex items-center gap-1.5 pt-2 text-xs text-muted-foreground italic">
        <CornerUpRight className="size-3 shrink-0" aria-hidden />
        <span>Mensagem original apagada</span>
      </div>
    );
  }
  return (
    <button
      type="button"
      aria-label={`Ir para a mensagem original de ${author}`}
      onClick={() => onJumpTo(reply.id)}
      className="ml-[52px] flex max-w-full items-center gap-1.5 self-start pt-2 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:text-foreground"
    >
      <CornerUpRight className="size-3 shrink-0" aria-hidden />
      <span className="shrink-0 font-medium">@{author}</span>
      <span className="truncate">
        {reply.content || (reply.has_attachments ? "Anexo" : "")}
        {reply.content && reply.has_attachments ? " (com anexo)" : ""}
      </span>
    </button>
  );
}

/** Destaca o `@username` do usuário no texto (sem diferenciar maiúsculas), só onde é uma menção de verdade. */
export function highlightMention(content: string, username: string): ReactNode[] {
  if (!username) return [content];
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Mesma regra do servidor: o @ não pode vir colado a letra, dígito, _, . ou @, e o nome termina onde acaba o token.
  const re = new RegExp(`(^|[^A-Za-z0-9_.@])(@${escaped})(?![A-Za-z0-9_])`, "gi");
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of content.matchAll(re)) {
    const start = (match.index ?? 0) + (match[1]?.length ?? 0);
    if (start > last) out.push(content.slice(last, start));
    out.push(
      <mark key={start} className="rounded bg-primary/25 px-0.5 font-medium text-foreground">
        {match[2]}
      </mark>,
    );
    last = start + (match[2]?.length ?? 0);
  }
  if (last < content.length) out.push(content.slice(last));
  return out;
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
        <Button size="sm" onClick={() => void save()} disabled={invalid || saving}>
          Salvar
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
