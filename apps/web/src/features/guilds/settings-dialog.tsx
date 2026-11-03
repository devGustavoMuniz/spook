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
import { useT } from "@/i18n";
import { can, type Guild } from "@/lib/guild";
import { AuditTab } from "./audit-tab";
import { BansTab } from "./bans-tab";
import { DirtyContext } from "./dirty";
import { GeneralTab } from "./general-tab";
import { InvitesTab } from "./invites-tab";
import { RolesTab } from "./roles-tab";

export type SettingsTab = "general" | "roles" | "invites" | "bans" | "audit";

const HEAD = {
  general: { icon: Settings, key: "guilds.settings.general" },
  roles: { icon: Shield, key: "guilds.settings.roles" },
  invites: { icon: Link2, key: "guilds.settings.invites" },
  bans: { icon: Gavel, key: "guilds.settings.bans" },
  audit: { icon: ScrollText, key: "guilds.settings.audit" },
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
  const { t } = useT();
  const tabs: { id: SettingsTab; label: string }[] = [];
  if (can(guild, Permission.MANAGE_GUILD) || guild.is_owner)
    tabs.push({ id: "general", label: t("guilds.settings.tab.general") });
  if (can(guild, Permission.MANAGE_ROLES))
    tabs.push({ id: "roles", label: t("guilds.settings.tab.roles") });
  if (can(guild, Permission.CREATE_INVITE))
    tabs.push({ id: "invites", label: t("guilds.settings.tab.invites") });
  if (can(guild, Permission.BAN_MEMBERS))
    tabs.push({ id: "bans", label: t("guilds.settings.tab.bans") });
  if (can(guild, Permission.VIEW_AUDIT_LOG))
    tabs.push({ id: "audit", label: t("guilds.settings.tab.audit") });
  const start = tabs.some((x) => x.id === initialTab) ? initialTab : tabs[0]?.id;
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
        <DialogHead
          icon={head.icon}
          title={t(`${head.key}.title`)}
          description={t(`${head.key}.desc`, { name: guild.name })}
        />
        <DirtyContext.Provider value={report}>
          <Tabs
            value={tab}
            onValueChange={(v) => {
              if (dirty.current.size > 0) setDiscarding(v as SettingsTab);
              else setTab(v as SettingsTab);
            }}
            className="flex min-h-0 flex-1 flex-col gap-0"
          >
            <TabsList
              variant="underline"
              aria-label={t("guilds.settings.sections")}
              className="shrink-0 overflow-x-auto px-6"
            >
              {tabs.map((x) => (
                <TabsTrigger key={x.id} value={x.id} variant="underline">
                  {x.label}
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
          <AlertDialogTitle>{t("guilds.settings.discardTitle")}</AlertDialogTitle>
          <AlertDialogDescription>{t("guilds.settings.discardBody")}</AlertDialogDescription>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("guilds.common.keepEditing")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                dirty.current.clear();
                const next = discarding;
                setDiscarding(null);
                if (next === "close") onClose();
                else if (next) setTab(next);
              }}
            >
              {t("guilds.common.discard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
