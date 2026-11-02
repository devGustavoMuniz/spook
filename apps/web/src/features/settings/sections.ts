import { Bell, type LucideIcon, Mic, Monitor, Palette, UserRound } from "lucide-react";

export type SectionKey = "profile" | "notifications" | "voice" | "appearance" | "app";

export type Section = {
  key: SectionKey;
  label: string;
  description: string;
  icon: LucideIcon;
  /** Só existe no app para computador (some da navegação na web). */
  desktopOnly?: boolean;
};

export const SECTIONS: readonly Section[] = [
  {
    key: "profile",
    label: "Perfil",
    description: "Como você aparece para as outras pessoas e os dados da sua conta.",
    icon: UserRound,
  },
  {
    key: "notifications",
    label: "Notificações",
    description: "Avisos no app, push e o que está silenciado.",
    icon: Bell,
  },
  {
    key: "voice",
    label: "Voz e vídeo",
    description: "Microfone, alto-falante, câmera e a qualidade da tela compartilhada.",
    icon: Mic,
  },
  {
    key: "appearance",
    label: "Aparência",
    description: "Tema do app e acessibilidade de movimento.",
    icon: Palette,
  },
  {
    key: "app",
    label: "Aplicativo",
    description: "Bandeja e início com o sistema neste computador.",
    icon: Monitor,
    desktopOnly: true,
  },
];

export const sectionOf = (key: string | undefined) => SECTIONS.find((s) => s.key === key);
