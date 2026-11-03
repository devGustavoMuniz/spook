/** Formas de plural (chaves de `Intl.PluralRules`); `other` é obrigatória. `zero` (opcional) vale só para count === 0. */
export type PluralMessage = {
  zero?: string;
  one?: string;
  two?: string;
  few?: string;
  many?: string;
  other: string;
};

export type Message = string | PluralMessage;

/** Um arquivo de catálogo: chaves planas "namespace.parte.nome". */
export type MessageMap = Record<string, Message>;

export const LOCALES = ["pt-BR", "en"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "pt-BR";
