import type { TicketPayloadKind, TicketPayloadStatus } from "@spook/shared";
import { Bug, Lightbulb, type LucideIcon, MessageSquareText } from "lucide-react";
import type { MessageKey } from "@/i18n";

export const KINDS: readonly {
  value: TicketPayloadKind;
  labelKey: MessageKey;
  icon: LucideIcon;
}[] = [
  { value: "bug", labelKey: "feedback.kind.bug", icon: Bug },
  { value: "suggestion", labelKey: "feedback.kind.suggestion", icon: Lightbulb },
  { value: "feedback", labelKey: "feedback.kind.feedback", icon: MessageSquareText },
];

export const kindKey = (k: TicketPayloadKind): MessageKey => `feedback.kind.${k}`;
export const statusKey = (s: TicketPayloadStatus): MessageKey => `feedback.status.${s}`;

/** Variante do `Badge` por estado (aberto chama atenção; resolvido/fechado ficam discretos). */
export const STATUS_VARIANT: Record<
  TicketPayloadStatus,
  "info" | "warning" | "brand" | "success" | "secondary"
> = {
  open: "info",
  in_review: "warning",
  answered: "brand",
  resolved: "success",
  closed: "secondary",
};
