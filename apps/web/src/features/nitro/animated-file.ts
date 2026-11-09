import { sniffAnimated } from "@/lib/crop";

/**
 * O arquivo escolhido é uma imagem animada (GIF, WebP animado ou APNG)? Sem Nitro, essas imagens não sobem como
 * avatar nem banner: a interface avisa antes de chegar ao envio (o servidor confere de novo e responde 403).
 */
export async function isAnimatedImage(file: File): Promise<boolean> {
  if (file.type === "image/gif") return true;
  if (file.type !== "image/webp" && file.type !== "image/png") return false;
  try {
    const head = new Uint8Array(await file.slice(0, 65536).arrayBuffer());
    return sniffAnimated(file.type, head);
  } catch {
    return false;
  }
}
