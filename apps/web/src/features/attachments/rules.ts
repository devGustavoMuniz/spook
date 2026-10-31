import { formatBytes } from "@/lib/file-size";

// Mesmas regras do servidor (server/internal/attachment/validate.go; SPEC 5.5, Fase 6a). O cliente
// valida antes de gastar banda, mas quem decide é o servidor.

export const MAX_FILE_SIZE = 25 * 1024 * 1024;
export const MAX_ATTACHMENTS = 10;
const MAX_FILENAME = 255;

/** Tipos aceitos e as extensões que combinam com cada um. */
export const ALLOWED_TYPES: Readonly<Record<string, readonly string[]>> = {
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/gif": ["gif"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
  "text/plain": ["txt", "log", "md", "csv"],
  "application/zip": ["zip"],
  "audio/mpeg": ["mp3"],
  "audio/ogg": ["ogg", "oga", "opus"],
  "audio/webm": ["weba", "webm"],
  "video/mp4": ["mp4", "m4v"],
  "video/webm": ["webm"],
};

/** Para o atributo `accept` do seletor de arquivos. */
export const ACCEPT = Object.keys(ALLOWED_TYPES).join(",");

export type FileLike = { name: string; type: string; size: number };

const extOf = (name: string) => {
  const i = name.lastIndexOf(".");
  return i < 0 ? "" : name.slice(i + 1).toLowerCase();
};

/**
 * Tipo que vai no PUT (e na assinatura). O navegador às vezes não conhece a extensão (tipo vazio) ou
 * dá um tipo mais específico que o aceito (`text/csv`, `text/markdown`); nesses casos o tipo sai da
 * extensão. Um tipo conhecido e proibido (`image/svg+xml`) nunca é "corrigido".
 */
export function resolveContentType(file: FileLike): string {
  const type = file.type.toLowerCase();
  if (Object.hasOwn(ALLOWED_TYPES, type)) return type;
  const generic = type === "" || type === "application/octet-stream";
  if (!generic && !type.startsWith("text/")) return type;
  const ext = extOf(file.name);
  if (generic && ext === "webm") return "video/webm";
  const found = Object.keys(ALLOWED_TYPES).find((t) => ALLOWED_TYPES[t]?.includes(ext));
  if (!found) return type;
  // Tipo de texto específico (csv, markdown) só vale como text/plain.
  return generic || found === "text/plain" ? found : type;
}

/** Mensagem em pt-br do primeiro problema do arquivo, ou `null` se ele pode ser enviado. */
export function validateFile(file: FileLike): string | null {
  const name = `"${file.name}"`;
  if (file.size < 1) return `${name} está vazio.`;
  if (file.size > MAX_FILE_SIZE)
    return `${name} passa do limite de 25 MB (tem ${formatBytes(file.size)}).`;
  if (file.name.length > MAX_FILENAME) return `${name}: o nome do arquivo é longo demais.`;
  const type = resolveContentType(file);
  const exts = Object.hasOwn(ALLOWED_TYPES, type) ? ALLOWED_TYPES[type] : undefined;
  if (!exts) return `${name}: este tipo de arquivo não é permitido.`;
  if (!exts.includes(extOf(file.name)))
    return `${name}: a extensão do nome não combina com o tipo do arquivo.`;
  return null;
}
