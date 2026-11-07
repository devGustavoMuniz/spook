// Links de convite do próprio domínio (`https://<este-host>/invite/<código>`) dentro de mensagens e do composer.

import { publicOrigin } from "@/lib/public-origin";

const CODE = "[A-Za-z0-9_-]{4,64}";

/** Máximo de cartões por mensagem (evita uma parede de cartões). */
export const MAX_INVITE_CARDS = 2;

/**
 * Hosts reconhecidos como "o próprio domínio": o da página e o público (no app desktop a página é `tauri.localhost`,
 * mas os convites circulam com o domínio de produção). Trocável nos testes.
 */
function ownHosts(): string[] {
  const hosts = new Set<string>();
  try {
    hosts.add(window.location.host);
    hosts.add(new URL(publicOrigin()).host);
  } catch {
    // sem window (testes de nó): fica só o que deu para ler
  }
  return [...hosts].filter(Boolean);
}

/** Códigos de convite do próprio domínio no texto, na ordem em que aparecem, sem repetir. */
export function extractInviteCodes(text: string, host: string | string[] = ownHosts()): string[] {
  const hosts = (Array.isArray(host) ? host : [host]).filter(Boolean);
  if (hosts.length === 0 || !text.includes("/invite/")) return [];
  const escaped = hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9.-])https?://(?:${escaped})/invite/(${CODE})(?![A-Za-z0-9_-])`,
    "gi",
  );
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) if (m[1]) seen.add(m[1]);
  return [...seen].slice(0, MAX_INVITE_CARDS);
}
