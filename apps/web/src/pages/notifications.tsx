import { Link } from "@tanstack/react-router";
import { Bell, BellOff, BellRing, MessageSquareDot, MonitorSmartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import { useNotificationPrefs } from "@/features/notifications/prefs";
import { NotificationDefaultsCard } from "@/features/notifications/settings-card";
import type { PushStatus } from "@/features/push/push";
import { usePushSettings } from "@/features/push/use-push";
import { SettingRow, SettingsGroup } from "@/features/settings/ui";

/** `/settings/notifications`: silenciar avisos in-app e ativar o push neste dispositivo. */
export function NotificationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <InAppCard />
      <NotificationDefaultsCard />
      {isTauri() ? <NativeCard /> : <PushCard />}
    </div>
  );
}

function InAppCard() {
  const muted = useNotificationPrefs((s) => s.muted);
  const setMuted = useNotificationPrefs((s) => s.setMuted);
  return (
    <SettingsGroup
      icon={MessageSquareDot}
      title="Avisos no app"
      description="Enquanto o Spook está aberto, mostramos um aviso quando chega uma mensagem direta ou uma menção em um canal que você não está vendo."
    >
      <SettingRow
        htmlFor="mute-notifications"
        label="Silenciar notificações"
        hint="Vale só neste navegador ou app. As contagens de não lidas continuam aparecendo."
      >
        <Switch id="mute-notifications" checked={muted} onCheckedChange={setMuted} />
      </SettingRow>
    </SettingsGroup>
  );
}

/** No app desktop não há Web Push: os avisos saem como notificações nativas do sistema. */
function NativeCard() {
  return (
    <SettingsGroup
      icon={MonitorSmartphone}
      title="Notificações do sistema"
      description="Este app usa notificações nativas do sistema. Quando o Spook não está em foco, mensagens diretas e menções aparecem como notificações do seu sistema operacional. Para ajustar ou bloquear, use as configurações de notificações do sistema. Ao clicar numa notificação, o Spook volta à frente e abre a conversa dela."
    >
      <Button asChild variant="outline" size="sm" className="self-start">
        <Link to="/settings/app">Bandeja e início com o sistema</Link>
      </Button>
    </SettingsGroup>
  );
}

const STATUS_TEXT: Record<PushStatus, string> = {
  checking: "Verificando…",
  unsupported: "Este navegador não oferece notificações push.",
  "needs-install":
    'No iPhone e no iPad, as notificações só funcionam com o Spook instalado: toque em Compartilhar, escolha "Adicionar à Tela de Início" e abra o Spook pelo ícone.',
  "server-off": "As notificações push estão desligadas neste servidor.",
  blocked:
    "As notificações estão bloqueadas para este site. Libere nas configurações do navegador (o cadeado ao lado do endereço) e volte aqui.",
  inactive: "Desativadas neste dispositivo.",
  active: "Ativas neste dispositivo.",
};

function PushCard() {
  const { status, busy, error, enable, disable } = usePushSettings();
  return (
    <SettingsGroup
      icon={BellRing}
      title="Notificações push"
      description="Receba mensagens diretas e menções mesmo com o Spook fechado. O aviso só chega quando você não está com o app aberto, e o navegador vai pedir sua permissão ao ativar."
    >
      <output
        className="flex items-start gap-2 rounded-lg bg-surface-1 px-3 py-2.5 text-sm"
        data-status={status}
      >
        {status === "active" ? (
          <Bell className="mt-0.5 size-4 shrink-0 text-success-text" aria-hidden />
        ) : (
          <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span>{STATUS_TEXT[status]}</span>
      </output>
      <div className="flex gap-2">
        {status === "inactive" ? (
          <Button onClick={() => void enable()} loading={busy}>
            Ativar notificações
          </Button>
        ) : null}
        {status === "active" ? (
          <Button variant="outline" onClick={() => void disable()} loading={busy}>
            Desativar notificações
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-destructive-text">
          {error}
        </p>
      ) : null}
    </SettingsGroup>
  );
}
