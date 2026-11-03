import { MessageSquare, Mic, MonitorUp, Video } from "lucide-react";
import { Lettering, LogoMark } from "@/components/brand";
import { useT } from "@/i18n";

const features = [
  { key: "shell.brand.chat", icon: MessageSquare },
  { key: "shell.brand.voice", icon: Mic },
  { key: "shell.brand.video", icon: Video },
  { key: "shell.brand.screenShare", icon: MonitorUp },
] as const;

/**
 * Bloco de marca das telas de entrada (SPEC 9.1): mascote com brilho neon, lettering (alinhados ao mesmo eixo: centro no mobile, esquerda no desktop) e as duas frases oficiais.
 * O halo e a flutuação só usam transform/opacity e param com movimento reduzido (CSS base).
 */
export function BrandHero({ className }: { className?: string }) {
  const { t } = useT();
  return (
    <div
      className={`flex flex-col items-center gap-3 text-center lg:gap-4 lg:items-start lg:text-left ${className ?? ""}`}
    >
      <div className="relative grid size-20 place-items-center lg:-ml-2.5 lg:size-40">
        <span
          aria-hidden="true"
          className="absolute inset-[-30%] animate-halo rounded-full bg-[radial-gradient(closest-side,color-mix(in_oklab,var(--brand-500)_55%,transparent),transparent)] blur-xl"
        />
        <div className="relative animate-float">
          <LogoMark size={160} glow alt="" className="size-20 lg:size-40" />
        </div>
      </div>
      {/* Lettering ~2x o anterior: na largura do fantasma ou um pouco mais (o asset tem folga de brilho nas pontas). */}
      <Lettering width={240} className="-mt-1 w-44 lg:-mt-2 lg:-ml-3 lg:w-60" />
      <p className="max-w-md text-xl font-semibold tracking-tight text-balance lg:text-3xl">
        {t("shell.brand.tagline")}
      </p>
      <ul
        aria-label={t("shell.brand.featuresAria")}
        className="flex flex-wrap justify-center gap-2 lg:justify-start"
      >
        {features.map(({ key, icon: Icon }) => (
          <li
            key={key}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-2/70 px-3 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm"
          >
            <Icon className="size-3.5 text-brand-text" aria-hidden="true" />
            {t(key)}
          </li>
        ))}
      </ul>
    </div>
  );
}
