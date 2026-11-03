import { Permission } from "@spook/shared";
import { Gavel, Link2, ScrollText, Settings, Shield } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogContent, DialogHead } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { can, type Guild } from "@/lib/guild";
import { AuditTab } from "./audit-tab";
import { BansTab } from "./bans-tab";
import { DirtyContext } from "./dirty";
import { GeneralTab } from "./general-tab";
import { InvitesTab } from "./invites-tab";
import { RolesTab } from "./roles-tab";

export type SettingsTab = "general" | "roles" | "invites" | "bans" | "audit";

const HEAD = {
  general: {
    icon: Settings,
    title: "Configurações do servidor",
    description: (g: Guild) => `Nome e ícone de ${g.name}.`,
  },
  roles: {
    icon: Shield,
    title: "Cargos e permissões",
    description: (g: Guild) => `Quem pode o quê em ${g.name}.`,
  },
  invites: {
    icon: Link2,
    title: "Convidar pessoas",
    description: (g: Guild) => `Links de convite de ${g.name}.`,
  },
  bans: {
    icon: Gavel,
    title: "Banimentos",
    description: (g: Guild) => `Quem está banido de ${g.name}.`,
  },
  audit: {
    icon: ScrollText,
    title: "Registro de auditoria",
    description: (g: Guild) => `Quem fez o quê em ${g.name}.`,
  },
} as const;

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
  if (can(guild, Permission.BAN_MEMBERS)) tabs.push({ id: "bans", label: "Banimentos" });
  if (can(guild, Permission.VIEW_AUDIT_LOG)) tabs.push({ id: "audit", label: "Auditoria" });
  const start = tabs.some((t) => t.id === initialTab) ? initialTab : tabs[0]?.id;
  const [tab, setTab] = useState<SettingsTab | undefined>(start);
  const dirty = useRef(new Set<string>());
  const [discarding, setDiscarding] = useState<"close" | SettingsTab | null>(null);
  const report = useCallback((key: string, isDirty: boolean) => {
    if (isDirty) dirty.current.add(key);
    else dirty.current.delete(key);
  }, []);
  const head = HEAD[tab ?? "general"];

  function requestClose() {
    if (dirty.current.size > 0) setDiscarding("close");
    else onClose();
  }

  return (
    <Dialog open onOpenChange={(o) => !o && requestClose()}>
      <DialogContent flush size="xl" className="h-[min(44rem,92svh)]">
        <DialogHead icon={head.icon} title={head.title} description={head.description(guild)} />
        <DirtyContext.Provider value={report}>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              if (dirty.current.size > 0) setDiscarding(v as SettingsTab);
              else setTab(v as SettingsTab);
            }}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <TabsList variant="underline" aria-label="Seções" className="shrink-0 px-6">
              {tabs.map((t) => (
                <TabsTrigger key={t.id} value={t.id} variant="underline">
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="general" className="min-h-0 flex-1 gap-0">
              <GeneralTab guild={guild} onClose={onClose} />
            </TabsContent>
            <TabsContent value="roles" className="min-h-0 flex-1 gap-0">
              <RolesTab guild={guild} />
            </TabsContent>
            <TabsContent value="invites" className="min-h-0 flex-1 gap-0">
              <InvitesTab guild={guild} />
            </TabsContent>
            <TabsContent value="bans" className="min-h-0 flex-1 gap-0">
              <BansTab guild={guild} />
            </TabsContent>
            <TabsContent value="audit" className="min-h-0 flex-1 gap-0">
              <AuditTab guild={guild} />
            </TabsContent>
          </Tabs>
        </DirtyContext.Provider>
      </DialogContent>
      <AlertDialog open={discarding !== null} onOpenChange={(o) => !o && setDiscarding(null)}>
        <AlertDialogContent>
          <AlertDialogTitle>Descartar alterações?</AlertDialogTitle>
          <AlertDialogDescription>
            Você mudou algo que ainda não foi salvo. Se continuar, as alterações se perdem.
          </AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>Continuar editando</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                dirty.current.clear();
                const next = discarding;
                setDiscarding(null);
                if (next === "close") onClose();
                else if (next) setTab(next);
              }}
            >
              Descartar
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
