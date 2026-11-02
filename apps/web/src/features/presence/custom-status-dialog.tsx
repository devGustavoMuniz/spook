import { SmilePlus } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { EXPIRY_OPTIONS, type ExpiryChoice, expiryFor, updatePresence } from "./actions";
import { liveCustom, usePresenceStore } from "./store";

const SUGGESTED = ["💬", "🎧", "🍽️", "🎮", "📚", "💻", "🌴", "🤒"];
const MAX_TEXT = 128;

/** Diálogo do status personalizado: texto (até 128), emoji opcional e quando ele some sozinho. */
export function CustomStatusDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [text, setText] = useState("");
  const [emoji, setEmoji] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("never");
  const [busy, setBusy] = useState(false);

  // Ao abrir, parte do status atual (a expiração volta a "Não limpar": o prazo original já correu em parte).
  useEffect(() => {
    if (!open) return;
    const cur = liveCustom(usePresenceStore.getState().mine.custom_status);
    setText(cur?.text ?? "");
    setEmoji(cur?.emoji ?? "");
    setExpiry("never");
  }, [open]);

  const empty = text.trim() === "" && emoji.trim() === "";

  async function save() {
    setBusy(true);
    const ok = await updatePresence({
      custom_status: { text: text.trim(), emoji: emoji.trim(), expires_at: expiryFor(expiry) },
    });
    setBusy(false);
    if (ok) onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent flush>
        <DialogHead
          icon={SmilePlus}
          title="Status personalizado"
          description="Aparece ao lado do seu nome na lista de membros e nas conversas."
        />
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            if (!empty && !busy) void save();
          }}
        >
          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="custom-status-text">O que você está fazendo?</Label>
              <div className="flex gap-2">
                <Input
                  aria-label="Emoji"
                  value={emoji}
                  onChange={(e) => setEmoji(e.target.value)}
                  maxLength={8}
                  className="w-16 text-center"
                  placeholder="🙂"
                />
                <Input
                  id="custom-status-text"
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  maxLength={MAX_TEXT}
                  placeholder="Ex.: em reunião"
                />
              </div>
              <fieldset className="flex flex-wrap gap-1">
                <legend className="sr-only">Emojis sugeridos</legend>
                {SUGGESTED.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className="rounded-md px-1.5 py-0.5 text-lg hover:bg-accent"
                    aria-label={`Usar ${s}`}
                    onClick={() => setEmoji(s)}
                  >
                    {s}
                  </button>
                ))}
              </fieldset>
              <span className="text-xs text-muted-foreground tabular-nums">
                {text.length}/{MAX_TEXT}
              </span>
            </div>
            <fieldset className="flex flex-col gap-1.5">
              <legend className="mb-1 text-sm font-medium">Limpar depois de</legend>
              {EXPIRY_OPTIONS.map((o) => (
                <label key={o.value} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="custom-status-expiry"
                    value={o.value}
                    checked={expiry === o.value}
                    onChange={() => setExpiry(o.value)}
                  />
                  {o.label}
                </label>
              ))}
            </fieldset>
          </DialogBody>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button type="submit" disabled={empty} loading={busy}>
              Salvar
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
