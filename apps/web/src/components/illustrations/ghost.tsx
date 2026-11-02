import type { ReactNode, SVGProps } from "react";
import { cn } from "@/lib/utils";

// Corpo do mascote (derivado de packages/brand/assets/mini-logo.svg): 112..288 x 76..318.
const BODY =
  "M112,196C112,116 156,76 200,76C244,76 288,116 288,196L288,305A13,13 0 0 1 275,318L272,318A13,13 0 0 1 259,305L259,306A10,10 0 0 0 239,306L239,305A13,13 0 0 1 226,318L223,318A13,13 0 0 1 210,305L210,306A10,10 0 0 0 190,306L190,305A13,13 0 0 1 177,318L174,318A13,13 0 0 1 161,305L161,306A10,10 0 0 0 141,306L141,305A13,13 0 0 1 128,318L125,318A13,13 0 0 1 112,305Z";

export type GhostMood = "happy" | "sleepy" | "lost";

/** Mascote em linhas, desenhado com tokens (`ghost-*`) para funcionar nos dois temas. */
export function Ghost({
  mood = "happy",
  headset = false,
  transform,
}: {
  mood?: GhostMood;
  headset?: boolean;
  transform?: string;
}) {
  return (
    <g transform={transform}>
      <path
        d={BODY}
        className="fill-ghost-body stroke-ghost-line"
        strokeWidth="9"
        strokeLinejoin="round"
      />
      {mood === "sleepy" ? (
        <g className="stroke-ghost-eye" fill="none" strokeWidth="6" strokeLinecap="round">
          <path d="M152,206Q167,216 182,206" />
          <path d="M218,206Q233,216 248,206" />
        </g>
      ) : mood === "lost" ? (
        <g className="fill-ghost-eye">
          <circle cx="168" cy="208" r="11" />
          <circle cx="232" cy="208" r="11" />
        </g>
      ) : (
        <g className="fill-ghost-eye">
          <path d="M152,198L182,208L178,222L156,218Z" />
          <path d="M248,198L218,208L222,222L244,218Z" />
        </g>
      )}
      {mood === "lost" ? (
        <path
          d="M188,258Q200,250 212,258"
          className="stroke-ghost-line"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
        />
      ) : (
        <path
          d="M186,252Q200,260 214,252"
          className="stroke-ghost-line"
          fill="none"
          strokeWidth="5"
          strokeLinecap="round"
        />
      )}
      {headset ? (
        <g>
          <path
            d="M97,172C97,16 303,16 303,172"
            className="stroke-ghost-accent"
            fill="none"
            strokeWidth="9"
            strokeLinecap="round"
          />
          <rect
            x="78"
            y="158"
            width="38"
            height="74"
            rx="17"
            className="fill-ghost-cup stroke-ghost-line"
            strokeWidth="4"
          />
          <rect
            x="284"
            y="158"
            width="38"
            height="74"
            rx="17"
            className="fill-ghost-cup stroke-ghost-line"
            strokeWidth="4"
          />
          <path
            d="M303,232C303,264 280,270 246,264"
            className="stroke-ghost-line"
            fill="none"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <circle cx="240" cy="263" r="9" className="fill-ghost-accent" />
        </g>
      ) : null}
    </g>
  );
}

/** Moldura comum: `aria-hidden`, viewBox 320x260, cresce com a largura do contêiner. */
export function IllustrationFrame({
  className,
  children,
  ...props
}: SVGProps<SVGSVGElement> & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 320 260"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={cn("h-auto w-full max-w-64", className)}
      {...props}
    >
      {children}
    </svg>
  );
}
