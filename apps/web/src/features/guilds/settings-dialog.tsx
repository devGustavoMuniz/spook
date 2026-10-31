import { Permission } from "@spook/shared";
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { can, type Guild } from "@/lib/guild";
import { GeneralTab } from "./general-tab";
import { InvitesTab } from "./invites-tab";
import { RolesTab } from "./roles-tab";

export type SettingsTab = "general" | "roles" | "invites";

/** Configurações do servidor: só as abas que o usuário pode usar (o servidor decide de verdade). */
export function GuildSettingsDialog({
  guild,
  initialTab,
  onClose,
}: {
  guild: Guild;
  initialTab: SettingsTab;
  onClose: () => void;
}) {
  const tabs: { id: SettingsTab; label: string }[] = [];
  if (can(guild, Permission.MANAGE_GUILD) || guild.is_owner)
    tabs.push({ id: "general", label: "Geral" });
  if (can(guild, Permission.MANAGE_ROLES)) tabs.push({ id: "roles", label: "Cargos" });
  if (can(guild, Permission.CREATE_INVITE)) tabs.push({ id: "invites", label: "Convites" });
  const start = tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0]?.id;
  const [tab, setTab] = useState<SettingsTab | undefined>(start);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{guild.name}</DialogTitle>
          <DialogDescription>Configurações do servidor</DialogDescription>
        </DialogHeader>
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v as SettingsTab)}
          className="flex flex-col gap-4"
        >
          <TabsList>
            {tabs.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="general">
            <GeneralTab guild={guild} onClose={onClose} />
          </TabsContent>
          <TabsContent value="roles">
            <RolesTab guild={guild} />
          </TabsContent>
          <TabsContent value="invites">
            <InvitesTab guild={guild} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
