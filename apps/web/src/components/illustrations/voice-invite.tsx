import type { SVGProps } from "react";
import { Ghost, IllustrationFrame } from "./ghost";

/** Convite para a voz: o mascote de headset com ondas de som. */
export function VoiceInviteIllustration(props: SVGProps<SVGSVGElement>) {
  return (
    <IllustrationFrame {...props}>
      <ellipse cx="160" cy="238" rx="64" ry="8" className="fill-ghost-line" opacity=".18" />
      <Ghost mood="happy" headset transform="translate(70 22) scale(.62)" />
      <g className="stroke-ghost-accent" fill="none" strokeWidth="5" strokeLinecap="round">
        <path d="M34,112q-12,22 0,44" />
        <path d="M18,100q-22,34 0,68" opacity=".55" />
        <path d="M286,112q12,22 0,44" />
        <path d="M302,100q22,34 0,68" opacity=".55" />
      </g>
      <g className="fill-ghost-line" opacity=".5">
        <rect x="132" y="26" width="5" height="12" rx="2.5" />
        <rect x="142" y="18" width="5" height="28" rx="2.5" />
        <rect x="152" y="22" width="5" height="20" rx="2.5" />
      </g>
    </IllustrationFrame>
  );
}
