import type { CropResult } from "@/components/image-cropper";
import type { Rect } from "@/lib/crop";
import { putWithProgress } from "@/lib/upload";

type ImageType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

/**
 * Envia o resultado do recorte pelo fluxo de sempre (presign, PUT com progresso) e devolve a chave final.
 * GIF com recorte: o original sobe e o servidor recorta quadro a quadro (`cropGif`); se o servidor recusar
 * (422: grande ou complexo demais) a chave devolvida é a do original e `fallback` vem `true`.
 */
export async function uploadCropped(opts: {
  result: CropResult;
  presign: (type: ImageType, size: number) => Promise<{ upload_url: string; key: string }>;
  cropGif?: (key: string, rect: Rect) => Promise<{ key: string }>;
  onProgress: (percent: number) => void;
}): Promise<{ key: string; fallback: boolean }> {
  const { result, presign, cropGif, onProgress } = opts;
  const { file } = result;
  const { upload_url, key } = await presign(file.type as ImageType, file.size);
  await putWithProgress(upload_url, file, onProgress);
  if (result.mode !== "gif" || !result.rect || !cropGif) return { key, fallback: false };
  try {
    return { key: (await cropGif(key, result.rect)).key, fallback: false };
  } catch (e) {
    if ((e as { status?: number }).status === 422) return { key, fallback: true };
    throw e;
  }
}
