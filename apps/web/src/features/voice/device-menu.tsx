import { useRouter } from "@tanstack/react-router";
import { ChevronUp, Settings } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/i18n";
import { cn } from "@/lib/utils";
import { chooseDevice, listDevices } from "./controller";
import { loadDevicePrefs } from "./devices";
import type { DeviceInfo } from "./engine";
import { useStageHold } from "./stage/use-auto-hide";

export const LONG_PRESS_MS = 500;

const COPY = {
  audioinput: { title: "voice.devmenu.mic.title", aria: "voice.devmenu.mic.aria" },
  audiooutput: { title: "voice.devmenu.speaker.title", aria: "voice.devmenu.speaker.aria" },
} as const;

/**
 * Envolve o botão de microfone ou de fone com a "setinha" do Discord: um menu com os dispositivos de entrada ou
 * saída e o atalho para "Configurações de voz". Para não roubar a largura do nome no rodapé de 240 px, a setinha
 * é uma sobreposição no canto do botão que só aparece com o mouse sobre o grupo ou com o foco dentro dele. O mesmo
 * menu abre com botão direito e com toque longo (500 ms) no botão, que é o caminho em telas de toque.
 */
export function DeviceMenu({
  kind,
  children,
  className,
}: {
  kind: keyof typeof COPY;
  /** O botão de microfone/fone. */
  children: ReactNode;
  className?: string;
}) {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [devices, setDevices] = useState<DeviceInfo[] | null>(null);
  const [chosen, setChosen] = useState("");
  const router = useRouter({ warn: false });
  const press = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const longPressed = useRef(false);
  useStageHold(open);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setChosen(loadDevicePrefs()[kind] ?? "");
    setDevices(null);
    void listDevices(kind).then((list) => alive && setDevices(list));
    return () => {
      alive = false;
    };
  }, [open, kind]);
  useEffect(() => () => clearTimeout(press.current), []);

  const copy = COPY[kind];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: botão direito e toque longo são atalhos; o menu tem a setinha focável
    <span
      className={cn("group/dev relative inline-flex shrink-0", className)}
      onContextMenu={(e) => {
        e.preventDefault();
        setOpen(true);
      }}
      onPointerDown={(e) => {
        if (e.pointerType !== "touch") return;
        longPressed.current = false;
        clearTimeout(press.current);
        press.current = setTimeout(() => {
          longPressed.current = true;
          setOpen(true);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={() => clearTimeout(press.current)}
      onPointerCancel={() => clearTimeout(press.current)}
      onPointerLeave={() => clearTimeout(press.current)}
      // Depois de um toque longo o clique que sobra não deve silenciar/ensurdecer.
      onClickCapture={(e) => {
        if (longPressed.current) {
          longPressed.current = false;
          e.preventDefault();
          e.stopPropagation();
        }
      }}
    >
      {children}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t(copy.aria)}
            title={t(copy.aria)}
            className={cn(
              "absolute -right-1.5 -bottom-1.5 z-10 flex size-5 cursor-pointer items-center justify-center rounded-full border border-border bg-popover text-muted-foreground opacity-0 shadow-xs transition-opacity duration-[var(--dur-fast)] hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring group-focus-within/dev:opacity-100 group-hover/dev:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:hidden",
            )}
          >
            <ChevronUp className="size-3" aria-hidden />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="max-h-80 w-64 overflow-y-auto">
          <DropdownMenuLabel>{t(copy.title)}</DropdownMenuLabel>
          {devices === null ? (
            <DropdownMenuItem disabled>{t("voice.devmenu.loading")}</DropdownMenuItem>
          ) : (
            <DropdownMenuRadioGroup
              value={chosen}
              onValueChange={(id) => {
                setChosen(id);
                void chooseDevice(kind, id);
              }}
            >
              <DropdownMenuRadioItem value="">{t("voice.device.default")}</DropdownMenuRadioItem>
              {devices.map((d) => (
                <DropdownMenuRadioItem key={d.id} value={d.id}>
                  <span className="truncate">{d.label}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          )}
          {devices?.length === 0 ? (
            <DropdownMenuItem disabled>{t("voice.devmenu.none")}</DropdownMenuItem>
          ) : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => {
              if (router) void router.navigate({ to: "/settings/voice" });
              else window.location.assign("/settings/voice");
            }}
          >
            <Settings /> {t("voice.devmenu.settings")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}
