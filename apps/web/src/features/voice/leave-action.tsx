import { type LucideIcon, MonitorX, PhoneOff, ScreenShareOff } from "lucide-react";
import { useT } from "@/i18n";
import {
  leaveCall,
  screenWatchSupported,
  setScreenWatching,
  toggleScreenShare,
} from "./controller";
import { useVoiceStore } from "./store";

export type LeaveKind = "leave" | "stopWatching" | "stopSharing";

export type LeaveAction = {
  kind: LeaveKind;
  label: string;
  Icon: LucideIcon;
  run: () => void;
  /** Rótulo do caminho secundário para sair da chamada (só quando o principal não é "sair"). */
  leaveLabel: string;
  leave: () => void;
};

/**
 * O botão vermelho da chamada muda conforme o que estou fazendo: compartilhando a tela vira "Parar de
 * compartilhar" (vence se também assisto), assistindo a tela de outra pessoa vira "Sair da transmissão", senão
 * "Sair da chamada". Sem seleção de telas na engine (desktop assina todas) não há como parar de assistir: fica "sair".
 */
export function useLeaveAction(leaveLabel?: string): LeaveAction {
  const { t } = useT();
  const sharing = useVoiceStore((s) => s.screen);
  const tracks = useVoiceStore((s) => s.videoTracks);
  const remoteScreens = tracks
    .filter((v) => v.kind === "screen" && !v.local)
    .map((v) => v.identity);
  const leaveText = leaveLabel ?? t("voice.leaveCall");
  const base = { leaveLabel: leaveText, leave: () => void leaveCall() };
  if (sharing) {
    return {
      ...base,
      kind: "stopSharing",
      label: t("voice.leave.stopSharing"),
      Icon: ScreenShareOff,
      run: () => void toggleScreenShare(),
    };
  }
  if (remoteScreens.length > 0 && screenWatchSupported()) {
    return {
      ...base,
      kind: "stopWatching",
      label: t("voice.leave.stopWatching"),
      Icon: MonitorX,
      run: () => {
        for (const id of new Set(remoteScreens)) setScreenWatching(id, false);
      },
    };
  }
  return { ...base, kind: "leave", label: leaveText, Icon: PhoneOff, run: base.leave };
}
