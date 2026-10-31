import { Bell, BellOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { isTauri } from "@/desktop/runtime";
import { useNotificationPrefs } from "@/features/notifications/prefs";
import type { PushStatus } from "@/features/push/push";
import { usePushSettings } from "@/features/push/use-push";

/** `/settings/notifications`: silenciar avisos in-app e ativar o push neste dispositivo. */
export function NotificationsPage() {
  return (
    <div className="flex flex-col gap-6">
      <InAppCard />
      {isTauri() ? <NativeCard /> : <PushCard />}
    </div>
  );
}

function InAppCard() {
  const muted = useNotificationPrefs((s) => s.muted);
  const setMuted = useNotificationPrefs((s) => s.setMuted);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Avisos no app</CardTitle>
        <CardDescription>
          Enquanto o Spook está aberto, mostramos um aviso quando chega uma mensagem direta ou uma
          menção em um canal que você não está vendo.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex items-center justify-between gap-4">
        <Label htmlFor="mute-notifications" className="flex flex-col gap-1">
          Silenciar notificações
          <span className="text-xs font-normal text-muted-foreground">
            Vale só neste navegador ou app. As contagens de não lidas continuam aparecendo.
          </span>
        </Label>
        <Switch id="mute-notifications" checked={muted} onCheckedChange={setMuted} />
      </CardContent>
    </Card>
  );
}

/** No app desktop não há Web Push: os avisos saem como notificações nativas do sistema. */
function NativeCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notificações do sistema</CardTitle>
        <CardDescription>
          Este app usa notificações nativas do sistema. Quando o Spook não está em foco, mensagens
          diretas e menções aparecem como notificações do seu sistema operacional. Para ajustar ou
          bloquear, use as configurações de notificações do sistema.
        </CardDescription>
      </CardHeader>
    </Card>
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
    <Card>
      <CardHeader>
        <CardTitle>Notificações push</CardTitle>
        <CardDescription>
          Receba mensagens diretas e menções mesmo com o Spook fechado. O aviso só chega quando você
          não está com o app aberto, e o navegador vai pedir sua permissão ao ativar.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <output className="flex items-start gap-2 text-sm" data-status={status}>
          {status === "active" ? (
            <Bell
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden
            />
          ) : (
            <BellOff className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span>{STATUS_TEXT[status]}</span>
        </output>
        <div className="flex gap-2">
          {status === "inactive" ? (
            <Button onClick={() => void enable()} disabled={busy}>
              {busy ? "Ativando…" : "Ativar notificações"}
            </Button>
          ) : null}
          {status === "active" ? (
            <Button variant="outline" onClick={() => void disable()} disabled={busy}>
              {busy ? "Desativando…" : "Desativar notificações"}
            </Button>
          ) : null}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
