import type { SVGProps } from "react";
import { Ghost, IllustrationFrame } from "./ghost";

/** 404 / erro: o mascote perdido, com uma interrogação e um cabo solto. */
export function NotFoundIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <IllustrationFrame {...props}>
      <ellipse cx="160" cy="238" rx="64" ry="8" className="fill-ghost-line" opacity=".18" />
      <Ghost mood="lost" transform="translate(40 30) scale(.6) rotate(-6 200 200)" />
      <path
        d="M246,48q0,-18 16,-18t16,16q0,10 -10,16t-6,16"
        className="stroke-ghost-accent"
        fill="none"
        strokeWidth="6"
        strokeLinecap="round"
      />
      <circle cx="262" cy="104" r="4" className="fill-ghost-accent" />
      <g className="stroke-ghost-line" fill="none" strokeWidth="4" strokeLinecap="round">
        <path d="M20,222q30,-6 44,6" />
        <path d="M64,228l8,-6m-8,6l8,6" />
        <path d="M84,224l6,-4M84,224l6,4" opacity=".6" />
      </g>
    </IllustrationFrame>
  );
}
