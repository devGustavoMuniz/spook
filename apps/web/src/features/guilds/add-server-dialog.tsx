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
import { useT } from "@/i18n";
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
  const { t } = useT();
  const [tab, setTab] = useState<"create" | "join">(initialTab);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent flush>
        <DialogHead
          icon={tab === "create" ? Plus : Compass}
          title={t("guilds.add.title")}
          description={t("guilds.add.description")}
        />
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as "create" | "join")}
          className="flex min-h-0 flex-1 flex-col gap-0"
        >
          <TabsList className="mx-6 mb-1 shrink-0 self-start">
            <TabsTrigger value="create">{t("guilds.add.tabCreate")}</TabsTrigger>
            <TabsTrigger value="join">{t("guilds.add.tabJoin")}</TabsTrigger>
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
  const { t } = useT();
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
      if (/limite|limit|100/i.test(msg)) setError("name", { message: msg });
      else toast.error(msg);
    }
  });

  return (
    <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogBody>
        <Field
          id="guild-name"
          label={t("guilds.add.nameLabel")}
          error={errors.name?.message}
          hint={t("guilds.add.nameHint")}
        >
          <Input
            id="guild-name"
            autoFocus
            placeholder={t("guilds.add.namePlaceholder")}
            maxLength={100}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy("guild-name", errors.name?.message, "hint")}
            {...register("name")}
          />
        </Field>
      </DialogBody>
      <DialogActions>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("guilds.common.cancel")}
        </Button>
        <Button type="submit" loading={isSubmitting}>
          {t("guilds.add.tabCreate")}
        </Button>
      </DialogActions>
    </form>
  );
}

function JoinForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { t } = useT();
  const navigate = useNavigate();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const code = parseInviteCode(value);
    if (!code) {
      setError(t("guilds.add.inviteEmpty"));
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
          label={t("guilds.add.inviteLabel")}
          error={error}
          hint={t("guilds.add.inviteHint")}
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
          {t("guilds.common.cancel")}
        </Button>
        <Button type="submit">{t("guilds.add.continue")}</Button>
      </DialogActions>
    </form>
  );
}
