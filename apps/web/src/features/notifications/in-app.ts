import type { MessagePayload, NotificationLevel } from "@spook/shared";
import { t } from "@/i18n";

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
      ? t("settings.notify.attachments", { count: m.attachments.length })
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
 * Decide se a mensagem merece aviso: nunca minha, não quando a pessoa já está olhando o canal, nunca
 * silenciada nem em "Não perturbar". Depois vale o nível: "all" avisa sempre, "mentions" só com menção
 * direta e "none" nunca. Sem `level`, o padrão é o de antes (DM avisa; servidor só com menção).
 * Menção direta, de cargo meu e `@everyone`/`@here` contam como menção; "Suprimir @everyone e @here" já vem
 * descontado em `bulkMention`.
 */
export function shouldNotify(args: {
  authorId: string;
  myId: string | null;
  isDm: boolean;
  mentionIds: readonly string[];
  /** Menção por cargo meu, `@everyone` ou `@here` (já descontado "Suprimir @everyone e @here"). */
  bulkMention?: boolean;
  viewing: "caught-up" | "focused" | "away";
  muted: boolean;
  /** Nível efetivo do canal (canal -> servidor -> padrão). */
  level?: NotificationLevel;
  /** "Não perturbar" ligado: nenhum aviso. */
  dnd?: boolean;
}): boolean {
  if (args.muted || args.dnd || !args.myId || args.authorId === args.myId) return false;
  if (args.viewing !== "away") return false;
  const level = args.level ?? (args.isDm ? "all" : "mentions");
  if (level === "all") return true;
  return level === "mentions" && (args.mentionIds.includes(args.myId) || !!args.bulkMention);
}
