import { useSyncExternalStore } from "react";
import { en } from "./messages/en";
import { ptBR } from "./messages/pt-BR";
import { DEFAULT_LOCALE, LOCALES, type Locale, type Message } from "./types";

export type MessageKey = keyof typeof ptBR;
export type Params = Record<string, string | number>;
export type TFunction = (key: MessageKey, params?: Params) => string;

const STORAGE_KEY = "spook-locale";
const catalogs: Record<Locale, Record<string, Message>> = { "pt-BR": ptBR, en };

export const isLocale = (v: unknown): v is Locale =>
  typeof v === "string" && (LOCALES as readonly string[]).includes(v);

/** Normaliza "pt", "pt-PT", "en-US"... para um idioma suportado (ou null). */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();
  if (lower === "pt" || lower.startsWith("pt-")) return "pt-BR";
  if (lower === "en" || lower.startsWith("en-")) return "en";
  return null;
}

/** localStorage -> navigator.language(s) -> pt-BR. */
export function detectLocale(): Locale {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (isLocale(stored)) return stored;
  } catch {
    // armazenamento indisponível: segue o navegador
  }
  if (typeof navigator !== "undefined") {
    for (const tag of navigator.languages?.length ? navigator.languages : [navigator.language]) {
      const m = matchLocale(tag);
      if (m) return m;
    }
  }
  return DEFAULT_LOCALE;
}

let current: Locale = detectLocale();
const listeners = new Set<() => void>();

function applyDocumentLang() {
  if (typeof document !== "undefined") document.documentElement.lang = current;
}
applyDocumentLang();

export const getLocale = (): Locale => current;

/** Troca o idioma ao vivo (sem recarregar), persiste no navegador e atualiza `<html lang>`. */
export function setLocale(next: Locale, opts: { persist?: boolean } = {}) {
  if (next === current) return;
  current = next;
  if (opts.persist !== false) {
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // sem persistência: vale só nesta sessão
    }
  }
  applyDocumentLang();
  for (const l of listeners) l();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}

function pick(msg: Message, locale: Locale, params?: Params): string {
  if (typeof msg === "string") return msg;
  const count = Number(params?.count ?? 0);
  if (count === 0 && msg.zero !== undefined) return msg.zero;
  const form = new Intl.PluralRules(locale).select(count);
  return msg[form] ?? msg.other;
}

/** Traduz `key` no idioma ativo: interpolação `{nome}`, plural por `count`, fallback pt-BR e depois a própria chave. */
export function t(key: MessageKey, params?: Params): string {
  const msg = catalogs[current][key] ?? catalogs["pt-BR"][key];
  if (msg === undefined) return key;
  const loc = catalogs[current][key] !== undefined ? current : "pt-BR";
  return interpolate(pick(msg, loc, params), params);
}

/** Registra um catálogo extra em runtime (só para testes do fallback). */
export function __setCatalogForTest(locale: Locale, cat: Record<string, Message>) {
  catalogs[locale] = cat;
}

// Uma função `t` com identidade própria por idioma: o React Compiler memoiza JSX pelas
// dependências, então `t` precisa mudar de identidade quando o idioma muda.
const boundT: Record<Locale, TFunction> = {
  "pt-BR": (key, params) => t(key, params),
  en: (key, params) => t(key, params),
};

/** Hook: re-renderiza quando o idioma muda e devolve `t`, `locale` e `setLocale`. Use nos componentes. */
export function useT() {
  const locale = useSyncExternalStore(subscribe, getLocale, getLocale);
  return { t: boundT[locale], locale, setLocale };
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

export { catalogs };
