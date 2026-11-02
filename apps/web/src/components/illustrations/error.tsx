import type { SVGProps } from "react";
import { Ghost, IllustrationFrame } from "./ghost";

/** Erro de rede / servidor / algo quebrou: o mascote sonolento com um cabo desconectado e faíscas. */
export function ErrorIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <IllustrationFrame {...props}>
      <ellipse cx="160" cy="238" rx="64" ry="8" className="fill-ghost-line" opacity=".18" />
      <Ghost mood="sleepy" transform="translate(40 30) scale(.6) rotate(4 200 200)" />
      <g className="stroke-ghost-line" fill="none" strokeWidth="5" strokeLinecap="round">
        <path d="M24,206q22,-4 34,10t14,20" />
        <path d="M296,206q-22,-4 -34,10t-14,20" />
      </g>
      <g className="stroke-ghost-accent" fill="none" strokeWidth="5" strokeLinecap="round">
        <path d="M24,206l-8,-10m8,10l-12,-2" />
        <path d="M296,206l8,-10m-8,10l12,-2" />
        <path d="M252,64l8,-14l-6,0l8,-14" />
      </g>
    </IllustrationFrame>
  );
}
