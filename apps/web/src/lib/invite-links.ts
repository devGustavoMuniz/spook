// Links de convite do próprio domínio (`https://<este-host>/invite/<código>`) dentro de mensagens e do composer.

const CODE = "[A-Za-z0-9_-]{4,64}";

/** Máximo de cartões por mensagem (evita uma parede de cartões). */
export const MAX_INVITE_CARDS = 2;

/** Origem usada para reconhecer "o próprio domínio"; trocável nos testes. */
function ownHost(): string {
  try {
    return window.location.host;
  } catch {
    return "";
  }
}

/** Códigos de convite do próprio domínio no texto, na ordem em que aparecem, sem repetir. */
export function extractInviteCodes(text: string, host: string = ownHost()): string[] {
  if (!host || !text.includes("/invite/")) return [];
  const escaped = host.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(
    `(?:^|[^A-Za-z0-9.-])https?://${escaped}/invite/(${CODE})(?![A-Za-z0-9_-])`,
    "gi",
  );
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) if (m[1]) seen.add(m[1]);
  return [...seen].slice(0, MAX_INVITE_CARDS);
}
