/** Cor de cargo: o servidor guarda RGB como inteiro (0..16777215); a interface usa "#rrggbb". */
export function colorToHex(color: number | null | undefined): string | undefined {
  if (color === null || color === undefined) return undefined;
  return `#${color.toString(16).padStart(6, "0")}`;
}

export function hexToColor(hex: string): number {
  return Number.parseInt(hex.replace("#", ""), 16);
}
