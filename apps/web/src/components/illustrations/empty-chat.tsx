import type { SVGProps } from "react";
import { Ghost, IllustrationFrame } from "./ghost";

/** Canal sem mensagens: o mascote cochilando entre balões de conversa. */
export function EmptyChatIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <IllustrationFrame {...props}>
      <ellipse cx="160" cy="236" rx="62" ry="8" className="fill-ghost-line" opacity=".18" />
      <Ghost mood="sleepy" transform="translate(40 28) scale(.6)" />
      <g className="stroke-ghost-line fill-ghost-body" strokeWidth="3" strokeLinejoin="round">
        <path d="M34,52h58a10,10 0 0 1 10,10v22a10,10 0 0 1 -10,10h-34l-14,12v-12h-10a10,10 0 0 1 -10,-10v-22a10,10 0 0 1 10,-10Z" />
        <path d="M232,96h50a10,10 0 0 1 10,10v18a10,10 0 0 1 -10,10h-6v10l-12,-10h-32a10,10 0 0 1 -10,-10v-18a10,10 0 0 1 10,-10Z" />
      </g>
      <g className="fill-ghost-accent">
        <circle cx="54" cy="73" r="4" />
        <circle cx="68" cy="73" r="4" opacity=".7" />
        <circle cx="82" cy="73" r="4" opacity=".4" />
        <circle cx="236" cy="115" r="3.5" />
        <circle cx="249" cy="115" r="3.5" opacity=".7" />
        <circle cx="262" cy="115" r="3.5" opacity=".4" />
      </g>
      <g className="stroke-ghost-accent" strokeWidth="3" strokeLinecap="round">
        <path d="M254,40v14M247,47h14" />
        <path d="M44,150v10M39,155h10" opacity=".6" />
      </g>
    </IllustrationFrame>
  );
}
