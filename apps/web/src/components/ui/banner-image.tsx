import * as React from "react";
import { canAnimateBanner, type PlanTier } from "@/features/nitro/plans";
import { cn } from "@/lib/utils";
import { isGifUrl, loadStaticFrame, peekStaticFrame, type StaticFrame } from "./static-frame";

/** Lado maior do quadro guardado do banner (os banners são largos; 640 cobre o cartão a 2x). */
const BANNER_MAX_SIDE = 640;

function StillBanner({ url, className }: { url: string; className?: string }) {
  const [frame, setFrame] = React.useState<StaticFrame | null | undefined>(() =>
    peekStaticFrame(url),
  );
  const canvasRef = React.useRef<HTMLCanvasElement>(null);

  React.useEffect(() => {
    let alive = true;
    const hit = peekStaticFrame(url);
    if (hit) {
      setFrame(hit);
      return;
    }
    setFrame(undefined);
    void loadStaticFrame(url, BANNER_MAX_SIDE).then((f) => {
      if (alive) setFrame(f);
    });
    return () => {
      alive = false;
    };
  }, [url]);

  React.useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!frame || !c) return;
    c.width = frame.width;
    c.height = frame.height;
    c.getContext("2d")?.drawImage(frame.canvas, 0, 0);
  }, [frame]);

  // Sem o quadro (carregando ou erro), nada: nunca cai no GIF animado de quem não tem Nitro.
  if (!frame) return null;
  return (
    <canvas ref={canvasRef} aria-hidden data-gif-still className={cn("object-cover", className)} />
  );
}

/**
 * Imagem de banner. GIF de dono sem plano (`ownerPlan` sem Nitro) aparece parado (primeiro quadro, num canvas);
 * quem tem Nitro mantém o GIF animado. Não-GIF é um `<img>` comum. A decisão é pelo plano de quem é DONO do banner.
 */
export function BannerImage({
  url,
  ownerPlan,
  className,
}: {
  url: string;
  ownerPlan: PlanTier | undefined;
  className?: string;
}) {
  if (isGifUrl(url) && !canAnimateBanner(ownerPlan))
    return <StillBanner url={url} className={className} />;
  return <img src={url} alt="" className={className} />;
}
