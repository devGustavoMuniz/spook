import { Ban, Bell, type LucideIcon, Mic, Monitor, Palette, UserRound } from "lucide-react";
import type { MessageKey } from "@/i18n";

export type SectionKey = "profile" | "notifications" | "blocked" | "voice" | "appearance" | "app";

export type Section = {
  key: SectionKey;
  labelKey: MessageKey;
  descriptionKey: MessageKey;
  icon: LucideIcon;
  /** Só existe no app para computador (some da navegação na web). */
  desktopOnly?: boolean;
};

export const SECTIONS: readonly Section[] = [
  {
    key: "profile",
    labelKey: "settings.sections.profile.label",
    descriptionKey: "settings.sections.profile.description",
    icon: UserRound,
  },
  {
    key: "notifications",
    labelKey: "settings.sections.notifications.label",
    descriptionKey: "settings.sections.notifications.description",
    icon: Bell,
  },
  {
    key: "blocked",
    labelKey: "settings.sections.blocked.label",
    descriptionKey: "settings.sections.blocked.description",
    icon: Ban,
  },
  {
    key: "voice",
    labelKey: "settings.sections.voice.label",
    descriptionKey: "settings.sections.voice.description",
    icon: Mic,
  },
  {
    key: "appearance",
    labelKey: "settings.sections.appearance.label",
    descriptionKey: "settings.sections.appearance.description",
    icon: Palette,
  },
  {
    key: "app",
    labelKey: "settings.sections.app.label",
    descriptionKey: "settings.sections.app.description",
    icon: Monitor,
    desktopOnly: true,
  },
];

export const sectionOf = (key: string | undefined) => SECTIONS.find((s) => s.key === key);
