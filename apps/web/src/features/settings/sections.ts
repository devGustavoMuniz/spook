import { Ban, Bell, type LucideIcon, Mic, Monitor, Palette, UserRound } from "lucide-react";
import type { MessageKey } from "@/i18n";

export type SectionKey = "profile" | "notifications" | "blocked" | "voice" | "appearance" | "app";

/** Estado do modal: uma seção ou `menu` (a lista de seções; só aparece em tela estreita). */
export type SettingsView = SectionKey | "menu";

export type SectionGroup = "account" | "app";

export type Section = {
  key: SectionKey;
  group: SectionGroup;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: LucideIcon;
  /** Só existe no app para computador (some da navegação na web). */
  desktopOnly?: boolean;
};

export const SECTIONS: readonly Section[] = [
  {
    key: "profile",
    group: "account",
    labelKey: "settings.sections.profile.label",
    descriptionKey: "settings.sections.profile.description",
    icon: UserRound,
  },
  {
    key: "notifications",
    group: "app",
    labelKey: "settings.sections.notifications.label",
    descriptionKey: "settings.sections.notifications.description",
    icon: Bell,
  },
  {
    key: "blocked",
    group: "account",
    labelKey: "settings.sections.blocked.label",
    descriptionKey: "settings.sections.blocked.description",
    icon: Ban,
  },
  {
    key: "voice",
    group: "app",
    labelKey: "settings.sections.voice.label",
    descriptionKey: "settings.sections.voice.description",
    icon: Mic,
  },
  {
    key: "appearance",
    group: "app",
    labelKey: "settings.sections.appearance.label",
    descriptionKey: "settings.sections.appearance.description",
    icon: Palette,
  },
  {
    key: "app",
    group: "app",
    labelKey: "settings.sections.app.label",
    descriptionKey: "settings.sections.app.description",
    icon: Monitor,
    desktopOnly: true,
  },
];

export const sectionOf = (key: string | undefined) => SECTIONS.find((s) => s.key === key);

/** Ordem do menu: grupo "Conta" (Perfil, Bloqueados) e grupo "App" (Notificações, Voz e vídeo, Aparência, Aplicativo). */
export const GROUPS: readonly { key: SectionGroup; labelKey: MessageKey }[] = [
  { key: "account", labelKey: "settings.layout.groupAccount" },
  { key: "app", labelKey: "settings.layout.groupApp" },
];

/** Valida o parâmetro `?settings=` da URL: seção conhecida, `menu` ou nada. */
export function parseView(value: unknown): SettingsView | undefined {
  if (value === "menu") return "menu";
  return typeof value === "string" ? sectionOf(value)?.key : undefined;
}
