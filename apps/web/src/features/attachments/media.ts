import type { AttachmentPayload } from "@spook/shared";

export const isImage = (a: Pick<AttachmentPayload, "content_type">) =>
  a.content_type.startsWith("image/");
export const isAudio = (a: Pick<AttachmentPayload, "content_type">) =>
  a.content_type.startsWith("audio/");
export const isVideo = (a: Pick<AttachmentPayload, "content_type">) =>
  a.content_type.startsWith("video/");

export const THUMB_MAX_WIDTH = 400;
export const THUMB_MAX_HEIGHT = 300;

/**
 * Tamanho exibido da imagem: cabe em 400x300 sem ampliar e mantém a proporção. Serve para reservar
 * o espaço antes de a imagem carregar (width/height vêm do servidor, da imagem original).
 */
export function fitSize(
  width: number,
  height: number,
  maxW = THUMB_MAX_WIDTH,
  maxH = THUMB_MAX_HEIGHT,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxW, height: Math.round((maxH * 3) / 4) };
  const scale = Math.min(1, maxW / width, maxH / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Imagens da mensagem, na ordem (a galeria do visualizador). */
export const imagesOf = (attachments: readonly AttachmentPayload[]) => attachments.filter(isImage);
