import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateGuild } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Compass, Plus } from "lucide-react";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogHead,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { appMessage } from "@/lib/app-errors";
import { appendGuild } from "@/lib/guild-cache";
import { type GuildNameForm, guildNameSchema, parseInviteCode } from "@/lib/schemas";

/** "Criar servidor" e "Entrar com convite" no mesmo diálogo (a barra de servidores e o estado vazio abrem ele). */
export function AddServerDialog({
  open,
  onOpenChange,
  initialTab = "create",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialTab?: "create" | "join";
}) {
  const [tab, setTab] = useState<"create" | "join">(initialTab);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent flush>
        <DialogHead
          icon={tab === "create" ? Plus : Compass}
          title="Adicionar um servidor"
          description="Crie o seu ou entre num que já existe."
        />
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "create" | "join")}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="mx-6 mb-1 shrink-0 self-start">
            <TabsTrigger value="create">Criar servidor</TabsTrigger>
            <TabsTrigger value="join">Entrar com convite</TabsTrigger>
          </TabsList>
          <TabsContent value="create" className="min-h-0 flex-1 gap-0">
            <CreateForm onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="join" className="min-h-0 flex-1 gap-0">
            <JoinForm onDone={() => onOpenChange(false)} onCancel={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const create = useCreateGuild();
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<GuildNameForm>({
    resolver: zodResolver(guildNameSchema),
    defaultValues: { name: "" },
  });

  const onSubmit = handleSubmit(async (data) => {
    try {
      const guild = await create.mutateAsync({ data });
      appendGuild(qc, guild);
      onDone();
      await navigate({ to: "/channels/$guildId", params: { guildId: guild.id } });
    } catch (e) {
      const msg = appMessage(e);
      if (/limite|100/i.test(msg)) setError("name", { message: msg });
      else toast.error(msg);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogBody>
        <Field
          id="guild-name"
          label="Nome do servidor"
          error={errors.name?.message}
          hint="Pode ser o nome do seu grupo, da turma ou do projeto. Dá para mudar depois."
        >
          <Input
            id="guild-name"
            autoFocus
            placeholder="Ex.: Laboratório de Go"
            maxLength={100}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy("guild-name", errors.name?.message, "hint")}
            {...register("name")}
          />
        </Field>
      </DialogBody>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit" loading={isSubmitting}>
          Criar servidor
        </Button>
      </DialogActions>
    </form>
  );
}

function JoinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const code = parseInviteCode(value);
    if (!code) {
      setError("Cole o link ou o código do convite.");
      return;
    }
    onDone();
    await navigate({ to: "/invite/$code", params: { code } });
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogBody>
        <Field
          id="invite-code"
          label="Link ou código do convite"
          error={error}
          hint="Exemplo: https://…/invite/ab12cd34 ou ab12cd34"
        >
          <Input
            id="invite-code"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
            aria-invalid={!!error}
            aria-describedby={describedBy("invite-code", error, "hint")}
          />
        </Field>
      </DialogBody>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancelar
        </Button>
        <Button type="submit">Continuar</Button>
      </DialogActions>
    </form>
  );
}
