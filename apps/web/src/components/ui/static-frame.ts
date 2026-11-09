// Primeiro quadro estático de um GIF (avatar parado), desenhado num <canvas>.
//
// Técnica: carrega a imagem uma vez e desenha o quadro inicial num canvas recortável. `drawImage` aceita imagem de
// outra origem (o S3 do avatar) sem "contaminar" o canvas, porque nunca lemos pixels. O quadro fica num cache por
// URL SEM a query (a assinatura do S3 muda a cada resposta, a chave do objeto não) e as cargas em andamento são
// compartilhadas: N avatares do mesmo GIF fazem UMA carga. O navegador reaproveita o mesmo GIF do cache HTTP
// quando o avatar de verdade começa a animar, então não há segundo download.

/** Lado máximo do quadro guardado (cobre o maior avatar, 128 px, a 2x). */
const MAX_SIDE = 256;
const MAX_ENTRIES = 300;

export type StaticFrame = { canvas: HTMLCanvasElement; width: number; height: number };

const frames = new Map<string, StaticFrame>();
const pending = new Map<string, Promise<StaticFrame | null>>();

/** A URL é de um GIF? Olha só o caminho (sem query): as chaves de avatar terminam em `.gif`. */
export function isGifUrl(url: string | undefined): url is string {
  if (!url) return false;
  const path = url.split(/[?#]/, 1)[0] ?? "";
  return path.toLowerCase().endsWith(".gif");
}

/** Chave do cache: a URL sem query/hash (a parte assinada muda, o objeto não). */
export function frameKey(url: string): string {
  return url.split(/[?#]/, 1)[0] ?? url;
}

/** Quadro já carregado (síncrono), para o primeiro render não piscar o placeholder. */
export function peekStaticFrame(url: string): StaticFrame | undefined {
  const key = frameKey(url);
  const hit = frames.get(key);
  if (hit) {
    // LRU simples: reinsere para ficar como o mais recente.
    frames.delete(key);
    frames.set(key, hit);
  }
  return hit;
}

/** Carrega (ou reaproveita) o primeiro quadro. `null` = não foi possível (erro de rede ou sem canvas). */
export function loadStaticFrame(url: string, maxSide = MAX_SIDE): Promise<StaticFrame | null> {
  const key = frameKey(url);
  const hit = peekStaticFrame(url);
  if (hit) return Promise.resolve(hit);
  const inflight = pending.get(key);
  if (inflight) return inflight;
  const p = new Promise<StaticFrame | null>((resolve) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => {
      try {
        const w = img.naturalWidth || 1;
        const h = img.naturalHeight || 1;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        const frame = { canvas, width: canvas.width, height: canvas.height };
        frames.set(key, frame);
        if (frames.size > MAX_ENTRIES) {
          const oldest = frames.keys().next().value;
          if (oldest !== undefined) frames.delete(oldest);
        }
        resolve(frame);
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = url;
  }).finally(() => pending.delete(key));
  pending.set(key, p);
  return p;
}

/** Desenha o quadro no canvas do avatar com o mesmo recorte do `object-fit: cover` (quadrado, centralizado). */
export function paintCover(target: HTMLCanvasElement, frame: StaticFrame) {
  const ctx = target.getContext("2d");
  if (!ctx) return;
  const side = Math.min(frame.width, frame.height);
  const sx = (frame.width - side) / 2;
  const sy = (frame.height - side) / 2;
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(frame.canvas, sx, sy, side, side, 0, 0, target.width, target.height);
}

/** Só para testes. */
export function resetStaticFrames() {
  frames.clear();
  pending.clear();
}
