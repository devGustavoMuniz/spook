import {
  isApiError,
  requestTicketUpload,
  type TicketUploadBody,
  type TicketUploadBodyContentType,
  type TicketUploadPayload,
} from "@spook/shared";
import { t } from "@/i18n";
import { formatBytes } from "@/lib/file-size";
import { resolveContentType } from "../attachments/rules";
import type { QueueRules, UploadGrant, UploadRequestBody } from "../attachments/upload-queue";
import { uploadErrorMessage } from "../attachments/upload-queue";

// Imagens (capturas de tela) dos chamados. Mesmas regras do servidor (server/internal/feedback/attachments.go):
// PNG, JPEG ou WebP, até 5 MB, até 3 por mensagem. O cliente valida antes de gastar banda; quem decide é o servidor.

export const TICKET_MAX_FILES = 3;
export const TICKET_MAX_BYTES = 5 * 1024 * 1024;
export const TICKET_IMAGE_TYPES: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
};
export const TICKET_ACCEPT = Object.keys(TICKET_IMAGE_TYPES).join(",");

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/** Mensagem do primeiro problema da imagem, ou `null` se ela pode ser enviada. */
export function validateTicketImage(file: Pick<File, "name" | "type" | "size">): string | null {
  const name = `"${file.name}"`;
  if (file.size < 1) return t("chat.attach.empty", { name });
  if (file.size > TICKET_MAX_BYTES)
    return t("chat.attach.tooBig", {
      name,
      limit: formatBytes(TICKET_MAX_BYTES),
      size: formatBytes(file.size),
    });
  const type = resolveContentType(file);
  const exts = Object.hasOwn(TICKET_IMAGE_TYPES, type) ? TICKET_IMAGE_TYPES[type] : undefined;
  if (!exts) return t("feedback.attach.typeNotAllowed", { name });
  if (!exts.includes(extOf(file.name))) return t("chat.attach.extMismatch", { name });
  return null;
}

export const ticketQueueRules: QueueRules = {
  maxFiles: TICKET_MAX_FILES,
  validate: validateTicketImage,
};

/**
 * Imagens coladas ou arrastadas costumam vir sem nome útil ("image.png", ou vazio): dá um nome com a extensão
 * do tipo para o servidor aceitar (a extensão precisa combinar com o tipo).
 */
export function nameCapture(file: File, seq: number): File {
  const exts = TICKET_IMAGE_TYPES[file.type];
  if (!exts || (file.name && exts.includes(extOf(file.name)))) return file;
  return new File([file], `captura-${seq}.${exts[0]}`, { type: file.type });
}

/** Texto de uma falha de upload de chamado (o 404 aqui é o chamado, não um canal). */
export function ticketUploadError(e: unknown): string {
  if (isApiError(e) && e.status === 404) return t("feedback.attach.ticketGone");
  return uploadErrorMessage(e);
}

type Api = (body: TicketUploadBody) => Promise<TicketUploadPayload>;

/**
 * Pedidos de upload de um chamado. Num chamado que já existe, cada pedido leva o ID dele. Num chamado novo, o
 * primeiro pedido reserva o ID (rascunho) e os seguintes esperam por ele e o reutilizam: assim todas as imagens
 * ficam sob o mesmo `tickets/<id>/` mesmo com os envios em paralelo.
 */
export function createTicketUploader(ticketId?: string, api: Api = requestTicketUpload) {
  let draft: Promise<string> | undefined;
  let draftId: string | undefined;

  const requestUpload = async (_scope: string, body: UploadRequestBody): Promise<UploadGrant> => {
    const base = { ...body, content_type: body.content_type as TicketUploadBodyContentType };
    if (ticketId) return api({ ...base, ticket_id: ticketId });
    if (!draft) {
      const first = api(base);
      const id = first.then((r) => {
        draftId = r.ticket_id;
        return r.ticket_id;
      });
      draft = id;
      id.catch(() => {
        draft = undefined;
      });
      return first;
    }
    return api({ ...base, ticket_id: await draft });
  };
  return {
    requestUpload,
    /** ID reservado do chamado novo (para `draft_id` ao criar); indefinido antes do primeiro upload. */
    getDraftId: () => draftId,
    /** Depois de criar o chamado: o próximo começa outro rascunho. */
    reset: () => {
      draft = undefined;
      draftId = undefined;
    },
  };
}

// As URLs de leitura são assinadas a cada resposta; a conversa do admin recarrega a cada 15 s e a assinatura nova
// faria as imagens piscarem. Mantém a primeira URL vista de cada imagem por 10 min (a validade no servidor é 15).
const PIN_MS = 10 * 60 * 1000;
const pinned = new Map<string, { url: string; at: number }>();

/** Devolve as imagens com a URL estável (a mesma entre recargas da conversa). */
export function pinAttachmentUrls<T extends { id: string; url: string }>(
  items: readonly T[] | null | undefined,
  now = Date.now(),
): T[] {
  return (items ?? []).map((a) => {
    const hit = pinned.get(a.id);
    if (hit && now - hit.at < PIN_MS) return hit.url === a.url ? a : { ...a, url: hit.url };
    pinned.set(a.id, { url: a.url, at: now });
    return a;
  });
}
