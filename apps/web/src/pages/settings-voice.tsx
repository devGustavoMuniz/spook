import { AudioLines, Headphones, MonitorUp } from "lucide-react";
import { useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import { usePlan } from "@/features/nitro/use-plan";
import { ChoiceCard, Hint, SettingRow, SettingsGroup, selectClass } from "@/features/settings/ui";
import { CallSoundsGroup } from "@/features/voice/call-sounds-settings";
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
  loadViewStreamPreviews,
  saveScreenSharePrefs,
  saveViewStreamPreviews,
} from "@/features/voice/devices";
import type {
  AudioCapabilities,
  AudioProcessingOptions,
  DeviceInfo,
  DeviceKind,
  NoiseSuppressionLevel,
} from "@/features/voice/engine";
import { MicTestSection } from "@/features/voice/mic-test-section";
import {
  clampScreenChoice,
  loadScreenChoice,
  type ScreenChoice,
  saveScreenChoice,
} from "@/features/voice/screen-quality";
import { ScreenQualityFields } from "@/features/voice/screen-share-fields";
import { useAudioStatusStore, useVoiceStore } from "@/features/voice/store";
import { type MessageKey, useT } from "@/i18n";

const FIELDS: { kind: DeviceKind; labelKey: MessageKey }[] = [
  { kind: "audioinput", labelKey: "settings.voice.microphone" },
  { kind: "audiooutput", labelKey: "settings.voice.speaker" },
  { kind: "videoinput", labelKey: "settings.voice.camera" },
];

const AUDIO_SWITCHES: {
  key: "echoCancellation" | "autoGainControl";
  labelKey: MessageKey;
  hintKey: MessageKey;
}[] = [
  {
    key: "echoCancellation",
    labelKey: "settings.voice.echo",
    hintKey: "settings.voice.echoHint",
  },
  {
    key: "autoGainControl",
    labelKey: "settings.voice.agc",
    hintKey: "settings.voice.agcHint",
  },
];

const NOISE_LEVELS: { value: NoiseSuppressionLevel; labelKey: MessageKey; hintKey: MessageKey }[] =
  [
    { value: "off", labelKey: "settings.voice.noiseOff", hintKey: "settings.voice.noiseOffHint" },
    {
      value: "standard",
      labelKey: "settings.voice.noiseStandard",
      hintKey: "settings.voice.noiseStandardHint",
    },
    {
      value: "strong",
      labelKey: "settings.voice.noiseStrong",
      hintKey: "settings.voice.noiseStrongHint",
    },
  ];

/**
 * `/settings/voice`: as mesmas escolhas do diálogo "Dispositivos" da chamada (mesmos controladores e
 * preferências em `features/voice`), agora numa tela própria, com teste de microfone e qualidade da tela.
 */
export function VoiceSettingsPage() {
  const { t } = useT();
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
        title={t("settings.voice.devices")}
        description={
          isTauri()
            ? t("settings.voice.devicesDescriptionDesktop")
            : t("settings.voice.devicesDescriptionWeb")
        }
      >
        {FIELDS.map(({ kind, labelKey }) => {
          const id = `device-${kind}`;
          return (
            <div key={kind} className="flex flex-col gap-1.5">
              <label htmlFor={id} className="text-sm font-medium">
                {t(labelKey)}
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
                <option value="">{t("settings.voice.systemDefault")}</option>
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
          title={t("settings.voice.micQuality")}
          description={t("settings.voice.micQualityDescription")}
        >
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">
              {t("settings.voice.noiseReduction")}
            </legend>
            {NOISE_LEVELS.map(({ value, labelKey, hintKey }) => {
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
                      ? `${t(labelKey)} (${caps.strongUnavailableReason})`
                      : t(labelKey)
                  }
                  hint={t(hintKey)}
                />
              );
            })}
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {noiseStatusText(processing.noiseSuppression, status)}
            </p>
          </fieldset>
          {AUDIO_SWITCHES.map(({ key, labelKey, hintKey }) => (
            <SettingRow
              key={key}
              htmlFor={`audio-processing-${key}`}
              label={t(labelKey)}
              hint={t(hintKey)}
            >
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
          title={t("settings.voice.testTitle")}
          description={t("settings.voice.testDescription")}
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
      <CallSoundsGroup />
    </div>
  );
}

function ScreenShareGroup({ caps }: { caps: AudioCapabilities }) {
  const { t } = useT();
  const plan = usePlan();
  const [stored, setChoice] = useState(loadScreenChoice);
  // O que aparece marcado nunca passa do plano (a preferência salva pode ser de quando havia Nitro).
  const choice = clampScreenChoice(stored, plan.limits);
  const [audio, setAudio] = useState(() => loadScreenSharePrefs().audio);
  const [viewPreviews, setViewPreviews] = useState(loadViewStreamPreviews);
  const canTune = caps.screenShareQuality === true;
  const noSystemAudio = caps.screenShareAudio === false;
  const pick = (c: ScreenChoice) => {
    setChoice(c);
    saveScreenChoice(c);
  };
  return (
    <SettingsGroup
      icon={MonitorUp}
      title={t("settings.voice.screenShare")}
      description={t("settings.voice.screenShareDescription")}
    >
      {canTune ? (
        <ScreenQualityFields idPrefix="settings-screen" choice={choice} onChange={pick} />
      ) : (
        <Hint>{t("settings.voice.screenAuto")}</Hint>
      )}
      {noSystemAudio ? null : (
        <SettingRow
          htmlFor="screen-share-audio-default"
          label={t("settings.voice.screenAudio")}
          hint={t("settings.voice.screenAudioHint")}
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
      <SettingRow
        htmlFor="view-stream-previews"
        label={t("settings.voice.previews")}
        hint={t("settings.voice.previewsHint")}
      >
        <Switch
          id="view-stream-previews"
          checked={viewPreviews}
          onCheckedChange={(on) => {
            setViewPreviews(on);
            saveViewStreamPreviews(on);
          }}
        />
      </SettingRow>
    </SettingsGroup>
  );
}
