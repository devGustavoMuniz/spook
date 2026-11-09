import { z } from "zod";
import { t } from "@/i18n";

export const TITLE_MIN = 3;
export const TITLE_MAX = 120;
export const BODY_MAX = 4000;

/** Mesmos limites do backend (huma): título 3-120, descrição 1-4000. */
export const newTicketSchema = z.object({
  kind: z.enum(["bug", "suggestion", "feedback"]),
  title: z
    .string()
    .trim()
    .min(TITLE_MIN, { error: () => t("feedback.validation.titleMin", { min: TITLE_MIN }) })
    .max(TITLE_MAX, { error: () => t("feedback.validation.titleMax", { max: TITLE_MAX }) }),
  description: z
    .string()
    .trim()
    .min(1, { error: () => t("feedback.validation.descriptionRequired") })
    .max(BODY_MAX, { error: () => t("feedback.validation.descriptionMax", { max: BODY_MAX }) }),
  includeContext: z.boolean(),
});
export type NewTicketForm = z.infer<typeof newTicketSchema>;

export const replySchema = z.object({
  body: z
    .string()
    .trim()
    .min(1, { error: () => t("feedback.validation.descriptionRequired") })
    .max(BODY_MAX, { error: () => t("feedback.validation.descriptionMax", { max: BODY_MAX }) }),
});
export type ReplyForm = z.infer<typeof replySchema>;
