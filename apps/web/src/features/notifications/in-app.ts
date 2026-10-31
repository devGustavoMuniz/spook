import type { MessagePayload } from "@spook/shared";

/** Aviso in-app de uma mensagem nova (toast ou notificação do navegador). */
export type InAppNotification = {
  channelId: string;
  title: string;
  body: string;
  /** `/channels/<servidor>/<canal>` ou `/channels/@me/<canal>`, como o payload do push. */
  url: string;
  mention: boolean;
};

const BODY_MAX = 120;

/** Texto curto como o do push: espaços colapsados, 120 caracteres, "📎 arquivo" se só há anexo. */
export function previewBody(m: Pick<MessagePayload, "content" | "attachments">): string {
  const text = m.content.replace(/\s+/g, " ").trim();
  if (text === "") {
    const first = m.attachments[0];
    if (!first) return "";
    return m.attachments.length > 1
      ? `📎 ${m.attachments.length} arquivos`
      : `📎 ${first.filename}`;
  }
  const runes = [...text];
  return runes.length > BODY_MAX ? `${runes.slice(0, BODY_MAX).join("")}…` : text;
}

export const channelUrl = (guildId: string | undefined, channelId: string) =>
  guildId ? `/channels/${guildId}/${channelId}` : `/channels/@me/${channelId}`;

/** Só aceita caminhos do próprio app (o `url` do push vem de fora do cliente). */
export function safeAppPath(url: unknown): string | null {
  return typeof url === "string" && /^\/channels\/(@me|[0-9]+)\/[0-9]+$/.test(url) ? url : null;
}

/**
 * Decide se a mensagem merece aviso: só DM ou menção direta, nunca minha, e não quando a pessoa já
 * está olhando o canal. `mentionIds` vazio em servidor = mensagem comum (sem aviso).
 */
export function shouldNotify(args: {
  authorId: string;
  myId: string | null;
  isDm: boolean;
  mentionIds: readonly string[];
  viewing: "caught-up" | "focused" | "away";
  muted: boolean;
}): boolean {
  if (args.muted || !args.myId || args.authorId === args.myId) return false;
  if (args.viewing !== "away") return false;
  return args.isDm || args.mentionIds.includes(args.myId);
}
