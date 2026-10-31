import type { MessagePayload } from "@spook/shared";
import { Pencil, Trash2 } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
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
  editing: boolean;
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
  return (
    <article
      aria-label={`Mensagem de ${name}`}
      data-mention={mentionsMe || undefined}
      className={`group relative flex flex-col px-4 hover:bg-accent/40 focus-within:bg-accent/40 ${
        mentionsMe ? "border-l-2 border-primary bg-primary/10" : ""
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
            </>
          )}
        </div>
      </div>
      {!p.editing && (p.canEdit || p.canDelete) ? (
        <div className="absolute -top-3 right-4 hidden gap-0.5 rounded-md border bg-popover p-0.5 shadow-sm group-focus-within:flex group-hover:flex">
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
