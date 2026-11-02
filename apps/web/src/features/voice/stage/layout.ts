/** Proporção dos tiles (16:9). */
export const TILE_RATIO = 16 / 9;
/** Abaixo desta largura (px) a grade vira uma coluna com rolagem. */
export const NARROW_STAGE = 600;
/** Largura mínima de um tile (px) antes de preferir menos colunas. */
export const MIN_TILE_WIDTH = 220;

export type GridLayout = { cols: number; rows: number; tileWidth: number };

/**
 * Melhor grade para `count` tiles 16:9 numa área `width` x `height`: escolhe o número de colunas que
 * dá o maior tile sem ultrapassar a área. Em área estreita é uma coluna só (a lista rola).
 */
export function bestGrid(width: number, height: number, count: number, gap: number): GridLayout {
  const n = Math.max(1, count);
  if (width <= 0) return { cols: 1, rows: n, tileWidth: 0 };
  if (width < NARROW_STAGE || height <= 0) {
    return { cols: 1, rows: n, tileWidth: Math.floor(width) };
  }
  const options: GridLayout[] = [];
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols);
    const byWidth = (width - gap * (cols - 1)) / cols;
    const byHeight = ((height - gap * (rows - 1)) / rows) * TILE_RATIO;
    options.push({ cols, rows, tileWidth: Math.floor(Math.min(byWidth, byHeight)) });
  }
  const max = Math.max(...options.map((o) => o.tileWidth));
  // Em tela larga, quase empatado prefere mais colunas (tiles lado a lado, como numa reunião);
  // duas pessoas ficam sempre lado a lado.
  const wanted = options.filter((o) => o.tileWidth >= max * (n === 2 ? 0 : 0.85));
  let best = wanted.reduce((a, b) =>
    b.cols > a.cols || (b.cols === a.cols && b.tileWidth > a.tileWidth) ? b : a,
  );
  if (n === 2) best = options[1] as GridLayout;
  // Tile pequeno demais: aceita rolagem vertical com tiles legíveis.
  if (best.tileWidth < MIN_TILE_WIDTH) {
    const cols = Math.max(1, Math.min(n, Math.floor((width + gap) / (MIN_TILE_WIDTH + gap))));
    const tileWidth = Math.floor((width - gap * (cols - 1)) / cols);
    return { cols, rows: Math.ceil(n / cols), tileWidth };
  }
  return best;
}
