// Quadro de vídeo vindo do Rust (espelho de `src-tauri/src/voice/wire.rs`):
//   [u32 little-endian: tamanho N do cabeçalho][N bytes: JSON UTF-8][bytes do JPEG]

export type FrameHeader = {
  trackId: string;
  participantId: string;
  source: "camera" | "screen";
  width: number;
  height: number;
  /** Instante da codificação (ms desde a época Unix). */
  timestamp: number;
};

export type DecodedFrame = { header: FrameHeader; jpeg: Uint8Array };

const decoder = new TextDecoder();

/** Aceita o que o Tauri entrega num canal binário: `ArrayBuffer`, `Uint8Array` ou lista de bytes. */
export function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (Array.isArray(data) && data.every((n) => typeof n === "number")) return Uint8Array.from(data);
  return null;
}

/** `null` se o quadro estiver truncado ou o cabeçalho for inválido (o quadro é descartado). */
export function decodeFrame(data: unknown): DecodedFrame | null {
  const bytes = toBytes(data);
  if (!bytes || bytes.byteLength < 4) return null;
  const n = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  if (n === 0 || 4 + n > bytes.byteLength) return null;
  try {
    const header = JSON.parse(decoder.decode(bytes.subarray(4, 4 + n))) as FrameHeader;
    if (typeof header.trackId !== "string" || !(header.width > 0) || !(header.height > 0))
      return null;
    return { header, jpeg: bytes.subarray(4 + n) };
  } catch {
    return null;
  }
}
