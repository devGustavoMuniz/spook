import { Bell, Play } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { SettingRow, SettingsGroup } from "@/features/settings/ui";
import {
  type CallSoundGroup,
  type CallSoundKind,
  loadCallSoundPrefs,
  noteUserGesture,
  playCallSound,
  SOUND_GROUPS,
  saveCallSoundPrefs,
} from "./call-sounds";

const SAMPLE: Record<CallSoundGroup, CallSoundKind> = {
  self: "join",
  toggles: "mute",
  peers: "peer-join",
  streams: "stream-start",
  ring: "ring",
};

/** Configurações > Voz e vídeo > Sons da chamada: volume único e um interruptor por tipo de som. */
export function CallSoundsGroup() {
  const [prefs, setPrefs] = useState(loadCallSoundPrefs);
  const update = (next: typeof prefs) => {
    setPrefs(next);
    saveCallSoundPrefs(next);
  };
  return (
    <SettingsGroup
      icon={Bell}
      title="Sons da chamada"
      description="Sons curtos para entrar, sair, silenciar e transmissões. Ficam mudos em Não perturbar."
    >
      <div className="flex flex-col gap-1">
        <label htmlFor="call-sounds-volume" className="flex justify-between text-sm font-medium">
          <span>Volume dos sons</span>
          <span className="tabular text-muted-foreground">{Math.round(prefs.volume * 100)}%</span>
        </label>
        <input
          id="call-sounds-volume"
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round(prefs.volume * 100)}
          aria-valuetext={`${Math.round(prefs.volume * 100)} por cento`}
          onChange={(e) => update({ ...prefs, volume: Number(e.target.value) / 100 })}
          className="cursor-pointer accent-primary"
        />
      </div>
      {SOUND_GROUPS.map((g) => (
        <SettingRow key={g.id} htmlFor={`call-sound-${g.id}`} label={g.label} hint={g.hint}>
          <span className="flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="size-7"
              aria-label={`Ouvir: ${g.label}`}
              disabled={!prefs.groups[g.id]}
              onClick={() => {
                noteUserGesture();
                playCallSound(SAMPLE[g.id]);
              }}
            >
              <Play />
            </Button>
            <Switch
              id={`call-sound-${g.id}`}
              checked={prefs.groups[g.id]}
              onCheckedChange={(on) =>
                update({ ...prefs, groups: { ...prefs.groups, [g.id]: on } })
              }
            />
          </span>
        </SettingRow>
      ))}
    </SettingsGroup>
  );
}
