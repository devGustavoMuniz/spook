import { useGetMe } from "@spook/shared";
import { useRouter } from "@tanstack/react-router";
import { Phone, PhoneOff } from "lucide-react";
import { useEffect, useRef } from "react";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { shownName } from "@/features/account/removed-user";
import { dmTitle } from "@/features/dms/dm-utils";
import { useDms } from "@/features/dms/use-dms";
import { startRing, stopRing } from "../voice/call-sounds";
import { answerCall, declineCall } from "./call-actions";
import { firstIncoming, useCallStore } from "./call-store";

/**
 * Chamada de DM recebida: cartão fixo no topo (`role="alertdialog"`), com o toque repetindo até alguém responder
 * ou a chamada expirar. O foco vai para "Atender"; Esc recusa. O servidor já não manda o toque a quem está em
 * "Não perturbar", com a conversa silenciada ou bloqueado.
 */
export function IncomingCalls() {
  const incoming = useCallStore((s) => s.incoming);
  const call = firstIncoming(incoming);
  const channelId = call?.channel_id;
  const expiresAt = call?.expires_at;
  const answer = useRef<HTMLButtonElement>(null);

  // O toque dura enquanto houver chamada tocando; some sozinho no vencimento (o servidor também avisa).
  useEffect(() => {
    if (!channelId) return;
    startRing();
    const left = expiresAt ? Date.parse(expiresAt) - Date.now() : 45_000;
    const t = setTimeout(() => useCallStore.getState().end(channelId), Math.max(0, left) + 1000);
    return () => {
      clearTimeout(t);
      stopRing();
    };
  }, [channelId, expiresAt]);

  useEffect(() => {
    if (channelId) answer.current?.focus();
  }, [channelId]);

  if (!call) return null;
  const others = Object.keys(incoming).length - 1;
  return <CallCard call={call} others={others} answerRef={answer} />;
}

function CallCard({
  call,
  others,
  answerRef,
}: {
  call: NonNullable<ReturnType<typeof firstIncoming>>;
  others: number;
  answerRef: React.RefObject<HTMLButtonElement | null>;
}) {
  const router = useRouter();
  const { data: me } = useGetMe();
  const dms = useDms();
  const channel = dms.list.find((c) => c.id === call.channel_id);
  const caller = call.caller;
  const callerName = caller ? shownName(caller.display_name, caller.username) : "Alguém";
  const title = channel && me ? dmTitle(channel, me.id) : callerName;

  async function accept() {
    void router.navigate({
      to: "/channels/@me/$channelId",
      params: { channelId: call.channel_id },
    });
    await answerCall(call.channel_id, title);
  }

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[var(--z-toast)] flex justify-center p-3 pt-[max(0.75rem,env(safe-area-inset-top))]">
      <div
        role="alertdialog"
        aria-modal="false"
        aria-labelledby="incoming-call-title"
        aria-describedby="incoming-call-desc"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            void declineCall(call.channel_id);
          }
        }}
        className="pointer-events-auto flex w-full max-w-md flex-col gap-3 rounded-xl border border-border bg-popover p-4 text-popover-foreground shadow-xl"
      >
        <div className="flex items-center gap-3">
          <Avatar url={caller?.avatar_url} name={callerName} seed={caller?.id} size={48} />
          <div className="min-w-0 flex-1">
            <p id="incoming-call-title" className="truncate font-semibold">
              {call.group && call.channel_name ? call.channel_name : callerName}
            </p>
            <p id="incoming-call-desc" className="text-sm text-muted-foreground">
              {call.group ? `${callerName} está ligando…` : "Chamada de voz recebida…"}
              {others > 0
                ? ` (+${others} ${others === 1 ? "outra chamada" : "outras chamadas"})`
                : ""}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button ref={answerRef} className="flex-1" onClick={() => void accept()}>
            <Phone /> Atender
          </Button>
          <Button
            variant="destructive"
            className="flex-1"
            onClick={() => void declineCall(call.channel_id)}
          >
            <PhoneOff /> Recusar
          </Button>
        </div>
      </div>
    </div>
  );
}
