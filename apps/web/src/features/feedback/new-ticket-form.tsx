import { zodResolver } from "@hookform/resolvers/zod";
import { getListMyTicketsQueryKey, isApiError, useCreateTicket } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquarePlus } from "lucide-react";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SettingsGroup } from "@/features/settings/ui";
import { useT } from "@/i18n";
import { messageFor } from "@/lib/errors";
import { cn } from "@/lib/utils";
import { AttachmentPicker, attachmentDropProps } from "./attachment-picker";
import { KINDS } from "./labels";
import { BODY_MAX, type NewTicketForm, newTicketSchema, TITLE_MAX } from "./schema";
import { useTechContext } from "./tech-context";
import { useTicketAttachments } from "./use-ticket-attachments";

/** Formulário de novo chamado: tipo, título, descrição e o contexto técnico (ligado por padrão, com prévia). */
export function NewTicketCard({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useT();
  const qc = useQueryClient();
  const create = useCreateTicket();
  const tech = useTechContext();
  const att = useTicketAttachments();
  const {
    register,
    handleSubmit,
    control,
    reset,
    watch,
    formState: { errors },
  } = useForm<NewTicketForm>({
    resolver: zodResolver(newTicketSchema),
    defaultValues: { kind: "bug", title: "", description: "", includeContext: true },
  });
  const includeContext = watch("includeContext");
  const descriptionLength = [...(watch("description") ?? "")].length;

  const onSubmit = handleSubmit(async (v) => {
    const ids = att.readyIds();
    if (!ids) return;
    const draftId = att.getDraftId();
    try {
      const ticket = await create.mutateAsync({
        data: {
          kind: v.kind,
          title: v.title,
          description: v.description,
          ...(v.includeContext ? { context: tech } : {}),
          ...(ids.length > 0 && draftId ? { draft_id: draftId, attachment_ids: ids } : {}),
        },
      });
      toast.success(t("feedback.new.sent"));
      reset();
      att.done();
      void qc.invalidateQueries({ queryKey: getListMyTicketsQueryKey() });
      onCreated(ticket.id);
    } catch (e) {
      toast.error(messageFor(e));
      if (ids.length > 0 && isApiError(e) && e.status >= 400 && e.status < 500) {
        att.rejected(t("feedback.attach.rejected"));
      }
    }
  });

  return (
    <SettingsGroup
      icon={MessageSquarePlus}
      title={t("feedback.new.title")}
      description={t("feedback.new.help")}
    >
      <form
        onSubmit={onSubmit}
        noValidate
        className="flex flex-col gap-4"
        {...attachmentDropProps(att)}
      >
        <Controller
          control={control}
          name="kind"
          render={({ field }) => (
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1.5 text-sm font-medium">{t("feedback.new.kind")}</legend>
              <div className="flex flex-wrap gap-2">
                {KINDS.map((k) => {
                  const checked = field.value === k.value;
                  return (
                    <label
                      key={k.value}
                      className={cn(
                        "flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ring",
                        checked
                          ? "border-primary bg-accent text-foreground"
                          : "border-border text-muted-foreground hover:border-brand-400 hover:text-foreground",
                      )}
                    >
                      <input
                        type="radio"
                        className="sr-only"
                        name="kind"
                        value={k.value}
                        checked={checked}
                        onChange={() => field.onChange(k.value)}
                      />
                      <k.icon className="size-4" aria-hidden />
                      {t(k.labelKey)}
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        />
        <Field id="ticket-title" label={t("feedback.new.titleLabel")} error={errors.title?.message}>
          <Input
            id="ticket-title"
            maxLength={TITLE_MAX}
            placeholder={t("feedback.new.titlePlaceholder")}
            aria-invalid={!!errors.title}
            aria-describedby={describedBy("ticket-title", errors.title?.message)}
            {...register("title")}
          />
        </Field>
        <Field
          id="ticket-description"
          label={t("feedback.new.description")}
          error={errors.description?.message}
          hint={t("feedback.attach.pasteHint")}
        >
          <Textarea
            id="ticket-description"
            rows={6}
            maxLength={BODY_MAX}
            placeholder={t("feedback.new.descriptionPlaceholder")}
            aria-invalid={!!errors.description}
            aria-describedby={describedBy(
              "ticket-description",
              errors.description?.message,
              t("feedback.attach.pasteHint"),
            )}
            {...register("description")}
          />
          <p className="text-right text-xs text-muted-foreground" aria-live="off">
            {`${descriptionLength}/${BODY_MAX}`}
          </p>
        </Field>
        <AttachmentPicker att={att} />
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-start justify-between gap-4">
            <label
              htmlFor="ticket-context"
              className="flex min-w-0 flex-col gap-0.5 text-sm font-medium"
            >
              {t("feedback.new.context")}
              <span className="text-xs font-normal text-pretty text-muted-foreground">
                {t("feedback.new.contextHint")}
              </span>
            </label>
            <Controller
              control={control}
              name="includeContext"
              render={({ field }) => (
                <Switch
                  id="ticket-context"
                  checked={field.value}
                  onCheckedChange={field.onChange}
                />
              )}
            />
          </div>
          {includeContext ? (
            <dl
              aria-label={t("feedback.new.contextPreview")}
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs text-muted-foreground"
            >
              <ContextRows context={{ ...tech }} />
            </dl>
          ) : null}
        </div>
        <Button type="submit" className="self-start" loading={create.isPending}>
          {t("feedback.new.submit")}
        </Button>
      </form>
    </SettingsGroup>
  );
}

/** Pares chave/valor do contexto técnico (usado na prévia e na conversa). */
export function ContextRows({ context }: { context: Record<string, string | undefined> }) {
  return (
    <>
      {Object.entries(context)
        .filter(([, v]) => !!v)
        .map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="font-medium">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
    </>
  );
}
