import { MessageSquare, Mic, MonitorUp, Video } from "lucide-react";
import { Lettering, Logo } from "@/components/brand";

const features = [
  { label: "Chat", icon: MessageSquare },
  { label: "Voz", icon: Mic },
  { label: "Vídeo", icon: Video },
  { label: "Compartilhar tela", icon: MonitorUp },
] as const;

/**
 * Bloco de marca das telas de entrada (SPEC 9.1): mascote com brilho neon, lettering e as duas frases oficiais.
 * O halo e a flutuação só usam transform/opacity e param com movimento reduzido (CSS base).
 */
export function BrandHero({ className }: { className?: string }) {
  return (
    <div
      className={`flex flex-col items-center gap-3 text-center lg:gap-4 lg:items-start lg:text-left ${className ?? ""}`}
    >
      <div className="relative grid size-20 place-items-center lg:size-44">
        <span
          aria-hidden="true"
          className="absolute inset-[-30%] animate-halo rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--brand-500)_55%,transparent),transparent)] blur-xl"
        />
        <div className="relative animate-float">
          <Logo
            size={176}
            className="size-20 drop-shadow-[0_0_18px_color-mix(in_oklab,var(--brand-400)_70%,transparent)] lg:size-44"
          />
        </div>
      </div>
      <Lettering height={40} />
      <p className="max-w-md text-xl font-semibold tracking-tight text-balance lg:text-3xl">
        Seus servidores, sua galera, num só lugar.
      </p>
      <ul
        aria-label="Chat, Voz, Vídeo e Compartilhar tela"
        className="flex flex-wrap justify-center gap-2 lg:justify-start"
      >
        {features.map(({ label, icon: Icon }) => (
          <li
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm"
          >
            <Icon className="size-3.5 text-brand-text" aria-hidden="true" />
            {label}
          </li>
        ))}
      </ul>
    </div>
  );
}
