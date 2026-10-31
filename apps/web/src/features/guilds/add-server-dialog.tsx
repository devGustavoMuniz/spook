import { zodResolver } from "@hookform/resolvers/zod";
import { useCreateGuild } from "@spook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { describedBy, Field } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
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
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Adicionar um servidor</DialogTitle>
          <DialogDescription>Crie o seu ou entre num que já existe.</DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={initialTab} className="flex flex-col gap-4">
          <TabsList>
            <TabsTrigger value="create">Criar servidor</TabsTrigger>
            <TabsTrigger value="join">Entrar com convite</TabsTrigger>
          </TabsList>
          <TabsContent value="create">
            <CreateForm onDone={() => onOpenChange(false)} />
          </TabsContent>
          <TabsContent value="join">
            <JoinForm onDone={() => onOpenChange(false)} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
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
    <form onSubmit={onSubmit} noValidate className="flex flex-col gap-4">
      <Field id="guild-name" label="Nome do servidor" error={errors.name?.message}>
        <Input
          id="guild-name"
          autoFocus
          maxLength={100}
          aria-invalid={!!errors.name}
          aria-describedby={describedBy("guild-name", errors.name?.message)}
          {...register("name")}
        />
      </Field>
      <Button type="submit" className="self-end" disabled={isSubmitting}>
        {isSubmitting ? "Criando…" : "Criar servidor"}
      </Button>
    </form>
  );
}

function JoinForm({ onDone }: { onDone: () => void }) {
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
    <form onSubmit={submit} noValidate className="flex flex-col gap-4">
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
      <Button type="submit" className="self-end">
        Continuar
      </Button>
    </form>
  );
}
