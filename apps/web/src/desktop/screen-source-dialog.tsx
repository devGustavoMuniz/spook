// Diálogo "O que compartilhar?": telas e janelas listadas pelo Rust. Acessível: grupo de opções (radio)
// navegável por setas, foco inicial na primeira opção, Esc/Cancelar recusam.
import { useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useT } from "@/i18n";
import { type ScreenSource, subscribeScreenPicker } from "./screen-picker";

type Pending = { sources: ScreenSource[]; resolve: (id: string | null) => void };

export function ScreenSourceDialog() {
  const { t } = useT();
  const [pending, setPending] = useState<Pending | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const group = useId();

  useEffect(() => subscribeScreenPicker(setPending), []);
  useEffect(() => {
    setChosen(pending?.sources[0]?.id ?? null);
  }, [pending]);

  const screens = pending?.sources.filter((s) => s.kind === "screen") ?? [];
  const windows = pending?.sources.filter((s) => s.kind === "window") ?? [];

  const section = (title: string, list: ScreenSource[]) =>
    list.length === 0 ? null : (
      <fieldset className="flex flex-col gap-1" aria-label={title}>
        <legend className="mb-1 text-sm font-medium">{title}</legend>
        {list.map((s) => (
          <label
            key={s.id}
            className="flex cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm has-[:checked]:border-primary has-[:focus-visible]:ring-2"
          >
            <input
              type="radio"
              name={group}
              value={s.id}
              checked={chosen === s.id}
              onChange={() => setChosen(s.id)}
            />
            <span className="truncate">{s.name}</span>
          </label>
        ))}
      </fieldset>
    );

  return (
    <Dialog open={!!pending} onOpenChange={(open) => !open && pending?.resolve(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.screenPicker.title")}</DialogTitle>
          <DialogDescription>{t("settings.screenPicker.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
          {section(t("settings.screenPicker.screens"), screens)}
          {section(t("settings.screenPicker.windows"), windows)}
          {pending && pending.sources.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("settings.screenPicker.none")}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => pending?.resolve(null)}>
            {t("settings.screenPicker.cancel")}
          </Button>
          <Button disabled={!chosen} onClick={() => chosen && pending?.resolve(chosen)}>
            {t("settings.screenPicker.share")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
