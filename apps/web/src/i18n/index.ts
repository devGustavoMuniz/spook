export {
  detectLocale,
  getLocale,
  isLocale,
  type MessageKey,
  matchLocale,
  setLocale,
  type TFunction,
  t,
  useLocale,
  useT,
} from "./core";
export {
  dateFnsLocale,
  formatBadge,
  formatList,
  formatNumber,
  formatRelativeUnit,
} from "./format";
export { I18nProvider } from "./provider";
export { DEFAULT_LOCALE, LOCALES, type Locale } from "./types";
export const LOCALE_NAMES = { "pt-BR": "Português (Brasil)", en: "English" } as const;
