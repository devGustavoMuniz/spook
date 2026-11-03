import { formatNumber } from "@/i18n";

/** Tamanho humanizado no idioma ativo (base 1024, como o limite de 25 MB do servidor): "512 B", "1,5 MB" / "1.5 MB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  // Uma casa decimal só quando ajuda (1,5 MB; 25 MB; 120 KB); o separador depende do idioma.
  const rounded = value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${formatNumber(rounded, { maximumFractionDigits: 1 })} ${units[i]}`;
}
