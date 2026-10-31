import { useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import {
  type AppSettings,
  getAppSettings,
  setAppSettings,
  shellErrorMessage,
} from "@/desktop/shell";

type Key = keyof AppSettings;

const OPTIONS: { key: Key; label: string; hint: string }[] = [
  {
    key: "closeToTray",
    label: "Fechar vai para a bandeja",
    hint: "Ao fechar a janela, o Spook continua rodando na bandeja do sistema (barra de menus no macOS) e a voz não cai. Para sair de verdade, use Sair no menu do ícone.",
  },
  {
    key: "startWithSystem",
    label: "Iniciar com o sistema",
    hint: "Abre o Spook quando você entra no computador.",
  },
  {
    key: "startMinimized",
    label: "Iniciar minimizado",
    hint: "Quando o Spook abre sozinho com o sistema, fica só na bandeja, sem mostrar a janela.",
  },
];

/** `/settings/app`: opções do app para computador. Na web a página só explica que não se aplica. */
export function AppSettingsPage() {
  return isTauri() ? (
    <DesktopOptions />
  ) : (
    <Card>
      <CardHeader>
        <CardTitle>Aplicativo</CardTitle>
        <CardDescription>
          Estas opções (bandeja, início com o sistema) existem só no app para computador.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}

function DesktopOptions() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    getAppSettings()
      .then((s) => alive && setSettings(s))
      .catch((e) => alive && setError(shellErrorMessage(e)));
    return () => {
      alive = false;
    };
  }, []);

  async function change(key: Key, value: boolean) {
    if (!settings || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSettings(await setAppSettings({ ...settings, [key]: value }));
    } catch (e) {
      // O Rust não gravou: o interruptor continua no valor anterior.
      setError(shellErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Aplicativo</CardTitle>
        <CardDescription>
          Como o Spook se comporta no seu computador. Estas escolhas valem só neste dispositivo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {OPTIONS.map(({ key, label, hint }) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <Label htmlFor={`app-${key}`} className="flex flex-col gap-1">
              {label}
              <span className="text-xs font-normal text-muted-foreground">{hint}</span>
            </Label>
            <Switch
              id={`app-${key}`}
              checked={settings?.[key] ?? false}
              disabled={!settings || busy}
              onCheckedChange={(v) => void change(key, v)}
            />
          </div>
        ))}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
