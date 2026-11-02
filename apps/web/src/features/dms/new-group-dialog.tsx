import { useOpenDM, useUpdateChannel } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Users } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
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
import { dmMessage } from "@/lib/app-errors";
import { upsertDM } from "@/lib/dm-cache";
import { PeoplePicker, useGuildPeople, useSelection } from "./people";

export const MAX_GROUP_INVITEES = 9; // dono + 9 = 10 participantes (SPEC 7.4)
export const MAX_GROUP_NAME = 100;

/** "Nova conversa em grupo": escolhe de 1 a 9 pessoas dos seus servidores e, se quiser, dá um nome. */
export function NewGroupDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useOpenDM();
  const rename = useUpdateChannel();
  const { people, pending } = useGuildPeople();
  const { selected, toggle, clear } = useSelection();
  const [name, setName] = useState("");
  const tooLong = [...name].length > MAX_GROUP_NAME;

  function close(o: boolean) {
    if (!o) {
      clear();
      setName("");
    }
    onOpenChange(o);
  }

  async function submit() {
    if (selected.size === 0 || tooLong) return;
    try {
      let ch = await create.mutateAsync({ data: { recipient_ids: [...selected] } });
      upsertDM(qc, ch);
      const trimmed = name.trim();
      if (trimmed) {
        try {
          ch = await rename.mutateAsync({ channelId: ch.id, data: { name: trimmed } });
          upsertDM(qc, ch);
        } catch (e) {
          toast.error(
            `A conversa foi criada, mas não deu para dar o nome: ${dmMessage(e, "rename")}`,
          );
        }
      }
      close(false);
      await navigate({ to: "/channels/@me/$channelId", params: { channelId: ch.id } });
    } catch (e) {
      toast.error(dmMessage(e, "create"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent flush>
        <DialogHead
          icon={Users}
          title="Nova conversa em grupo"
          description={`Escolha de 1 a ${MAX_GROUP_INVITEES} pessoas que estão em algum servidor com você.`}
        />
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogBody>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="group-name">Nome do grupo (opcional)</Label>
              <Input
                id="group-name"
                value={name}
                placeholder="Ex.: Estudo de Go"
                onChange={(e) => setName(e.target.value)}
                aria-invalid={tooLong}
              />
              {tooLong ? (
                <p role="alert" className="text-xs text-destructive-text">
                  O nome pode ter até {MAX_GROUP_NAME} caracteres.
                </p>
              ) : null}
            </div>
            <PeoplePicker
              people={people}
              pending={pending}
              selected={selected}
              max={MAX_GROUP_INVITEES}
              onToggle={toggle}
            />
          </DialogBody>
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => close(false)}>
              Cancelar
            </Button>
            <Button
              type="submit"
              disabled={selected.size === 0 || tooLong}
              loading={create.isPending}
            >
              Criar conversa
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
}
