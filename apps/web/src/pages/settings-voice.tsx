import { AudioLines, Headphones, MonitorUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import { ChoiceCard, Hint, SettingRow, SettingsGroup, selectClass } from "@/features/settings/ui";
import {
  audioCapabilities,
  chooseAudioProcessing,
  chooseDevice,
  listDevices,
  supportsAudioProcessing,
} from "@/features/voice/controller";
import { noiseStatusText } from "@/features/voice/device-dialog";
import {
  loadAudioProcessing,
  loadDevicePrefs,
  loadScreenSharePrefs,
  saveScreenSharePrefs,
} from "@/features/voice/devices";
import type {
  AudioCapabilities,
  AudioProcessingOptions,
  DeviceInfo,
  DeviceKind,
  NoiseSuppressionLevel,
  ScreenShareQuality,
} from "@/features/voice/engine";
import { MicTestSection } from "@/features/voice/mic-test-section";
import {
  estimateUplinkKbps,
  formatKbps,
  isHeavy,
  loadScreenQuality,
  presetIdOf,
  QUALITY_PRESETS,
  saveScreenQuality,
} from "@/features/voice/screen-quality";
import { useAudioStatusStore, useVoiceStore } from "@/features/voice/store";

const FIELDS: { kind: DeviceKind; label: string }[] = [
  { kind: "audioinput", label: "Microfone" },
  { kind: "audiooutput", label: "Alto-falante" },
  { kind: "videoinput", label: "Câmera" },
];

const AUDIO_SWITCHES: {
  key: "echoCancellation" | "autoGainControl";
  label: string;
  hint: string;
}[] = [
  {
    key: "echoCancellation",
    label: "Cancelamento de eco",
    hint: "Evita que os outros ouçam você de volta. Fones de ouvido evitam o eco de vez.",
  },
  {
    key: "autoGainControl",
    label: "Ajuste automático de volume",
    hint: "Mantém o volume da sua voz estável.",
  },
];

const NOISE_LEVELS: { value: NoiseSuppressionLevel; label: string; hint: string }[] = [
  {
    value: "off",
    label: "Desligada",
    hint: "Sua voz vai sem filtro. Melhor com microfone de estúdio.",
  },
  {
    value: "standard",
    label: "Padrão",
    hint: "Filtro embutido do navegador. Leve e bom para a maioria.",
  },
  {
    value: "strong",
    label: "Forte (IA)",
    hint: "Modelo de IA gratuito que remove teclado, ventilador e TV ao fundo. Usa mais processador.",
  },
];

/**
 * `/settings/voice`: as mesmas escolhas do diálogo "Dispositivos" da chamada (mesmos controladores e
 * preferências em `features/voice`), agora numa tela própria, com teste de microfone e qualidade da tela.
 */
export function VoiceSettingsPage() {
  const [devices, setDevices] = useState<Partial<Record<DeviceKind, DeviceInfo[]>>>({});
  const [chosen, setChosen] = useState(loadDevicePrefs);
  const [processing, setProcessing] = useState(loadAudioProcessing);
  const [canProcess, setCanProcess] = useState(false);
  const [caps, setCaps] = useState<AudioCapabilities>({ strongNoiseSuppression: false });
  const status = useAudioStatusStore((st) => st.status);
  const micOpenInCall = useVoiceStore((st) => st.status !== "idle" && !st.selfMute);

  useEffect(() => {
    let alive = true;
    setCanProcess(supportsAudioProcessing());
    setCaps(audioCapabilities());
    void Promise.all(FIELDS.map(async (f) => [f.kind, await listDevices(f.kind)] as const)).then(
      (entries) => alive && setDevices(Object.fromEntries(entries)),
    );
    return () => {
      alive = false;
    };
  }, []);

  // A IA foi rebaixada (sem suporte, falha ou lentidão): o controlador já gravou "Padrão"; a tela acompanha.
  useEffect(() => {
    if (status?.state === "degraded")
      setProcessing((p) => ({ ...p, noiseSuppression: status.level }));
  }, [status]);

  const update = (next: AudioProcessingOptions) => {
    setProcessing(next);
    void chooseAudioProcessing(next);
  };

  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup
        icon={Headphones}
        title="Dispositivos"
        description={
          isTauri()
            ? "A escolha fica salva neste computador e vale na chamada em curso."
            : "A escolha fica salva neste navegador. Os nomes só aparecem depois que o navegador liberar o acesso ao microfone ou à câmera."
        }
      >
        {FIELDS.map(({ kind, label }) => {
          const id = `device-${kind}`;
          return (
            <div key={kind} className="flex flex-col gap-1.5">
              <label htmlFor={id} className="text-sm font-medium">
                {label}
              </label>
              <select
                id={id}
                value={chosen[kind] ?? ""}
                onChange={(e) => {
                  setChosen((c) => ({ ...c, [kind]: e.target.value || undefined }));
                  void chooseDevice(kind, e.target.value);
                }}
                className={selectClass}
              >
                <option value="">Padrão do sistema</option>
                {(devices[kind] ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </SettingsGroup>

      {canProcess ? (
        <SettingsGroup
          icon={AudioLines}
          title="Qualidade do microfone"
          description="Como o Spook trata a sua voz antes de enviá-la."
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Redução de ruído</legend>
            {NOISE_LEVELS.map(({ value, label, hint }) => {
              const unavailable = value === "strong" && !caps.strongNoiseSuppression;
              return (
                <ChoiceCard
                  key={value}
                  id={`noise-${value}`}
                  name="noise-suppression"
                  checked={processing.noiseSuppression === value}
                  disabled={unavailable}
                  onChange={() => update({ ...processing, noiseSuppression: value })}
                  title={
                    unavailable && caps.strongUnavailableReason
                      ? `${label} (${caps.strongUnavailableReason})`
                      : label
                  }
                  hint={hint}
                />
              );
            })}
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {noiseStatusText(processing.noiseSuppression, status)}
            </p>
          </fieldset>
          {AUDIO_SWITCHES.map(({ key, label, hint }) => (
            <SettingRow key={key} htmlFor={`audio-processing-${key}`} label={label} hint={hint}>
              <Switch
                id={`audio-processing-${key}`}
                checked={processing[key]}
                onCheckedChange={(on) => update({ ...processing, [key]: on })}
              />
            </SettingRow>
          ))}
          {status?.gateError ? (
            <output className="block text-xs text-destructive-text">{status.gateError}</output>
          ) : null}
        </SettingsGroup>
      ) : null}

      {canProcess && (caps.inputSensitivity || caps.micTest) ? (
        <SettingsGroup
          icon={AudioLines}
          title="Teste e sensibilidade"
          description="Veja o nível da sua voz e ouça como os outros vão ouvir você."
        >
          <MicTestSection
            open
            processing={processing}
            caps={caps}
            inCall={micOpenInCall}
            onChange={update}
          />
        </SettingsGroup>
      ) : null}

      <ScreenShareGroup caps={caps} />
    </div>
  );
}

function ScreenShareGroup({ caps }: { caps: AudioCapabilities }) {
  const [quality, setQuality] = useState(loadScreenQuality);
  const [audio, setAudio] = useState(() => loadScreenSharePrefs().audio);
  const canTune = caps.screenShareQuality === true;
  const noSystemAudio = caps.screenShareAudio === false;
  const presetId = presetIdOf(quality);
  const choose = (q: ScreenShareQuality) => {
    setQuality(q);
    saveScreenQuality(q);
  };
  return (
    <SettingsGroup
      icon={MonitorUp}
      title="Compartilhamento de tela"
      description="Valores iniciais de quando você compartilhar a tela. Você ainda pode ajustar na hora."
    >
      {canTune ? (
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Qualidade</legend>
          {QUALITY_PRESETS.map((p) => (
            <ChoiceCard
              key={p.id}
              id={`screen-quality-${p.id}`}
              name="screen-quality"
              checked={presetId === p.id}
              onChange={() => choose({ ...p.quality })}
              title={p.label}
              hint={p.hint}
            />
          ))}
          {presetId === null ? (
            <Hint>Qualidade personalizada em uso (ajustada ao compartilhar).</Hint>
          ) : null}
          <Hint>
            Banda de subida estimada: até {formatKbps(estimateUplinkKbps(quality))} por espectador
            no pior caso (o uso real costuma ser menor).
          </Hint>
          {isHeavy(quality) ? (
            <output className="block rounded-lg border border-destructive/40 px-3 py-2 text-xs">
              Qualidade acima do padrão: gasta mais processador e internet de quem transmite e mais
              banda do servidor. Se a chamada engasgar, volte para Nitidez 1080p 15 fps.
            </output>
          ) : null}
        </fieldset>
      ) : (
        <Hint>
          A qualidade da imagem é automática neste app: ainda não dá para escolher resolução ou
          quadros por segundo.
        </Hint>
      )}
      {noSystemAudio ? null : (
        <SettingRow
          htmlFor="screen-share-audio-default"
          label="Incluir áudio por padrão"
          hint="Desligado por padrão: o som do computador pode carregar a voz dos outros e eles se ouvirão de volta (eco). Use fones se ligar."
        >
          <Switch
            id="screen-share-audio-default"
            checked={audio}
            onCheckedChange={(on) => {
              setAudio(on);
              saveScreenSharePrefs({ audio: on });
            }}
          />
        </SettingRow>
      )}
    </SettingsGroup>
  );
}
