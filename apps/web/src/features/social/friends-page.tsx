import { type Relationship, useGetMe, useListGuilds } from "@spook/shared";
import {
  Ban,
  Check,
  MessageCircle,
  MoreVertical,
  Phone,
  Send,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { type FormEvent, useMemo, useState } from "react";
import { EmptyChatIllustration } from "@/components/illustrations";
import { PresenceDot, StatusAvatar, statusLabel } from "@/components/presence-dot";
import { NavToggle } from "@/components/shell";
import { ErrorState } from "@/components/state-screen";
import { CountBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { shownName } from "@/features/account/removed-user";
import { CustomStatusText } from "@/features/presence/custom-status-text";
import { usePresence, usePresenceStore } from "@/features/presence/store";
import { useVoiceStatesStore } from "@/features/voice/store";
import { useT } from "@/i18n";
import { channelsOf } from "@/lib/guild";
import { type SocialConfirm, SocialConfirmDialog } from "./confirm";
import { useDmActions } from "./dm-actions";
import { useAllRelationships, useSocialActions } from "./hooks";
import { InviteToServerDialog } from "./invite-dialog";

type TabKey = "online" | "all" | "pending" | "blocked" | "add";

const nameOf = (r: Relationship) => shownName(r.user.display_name, r.user.username);

/** "Em voz em #canal · Servidor": só quando a pessoa está numa sala de um servidor que eu também vejo. */
function useVoiceActivity(userId: string): { channel: string; guild: string } | null {
  const state = useVoiceStatesStore((s) => s.byUser[userId]);
  const guilds = useListGuilds();
  if (!state?.guild_id || !state.channel_id) return null;
  const guild = guilds.data?.find((g) => g.id === state.guild_id);
  const channel = guild ? channelsOf(guild).find((c) => c.id === state.channel_id) : undefined;
  return guild && channel ? { channel: channel.name, guild: guild.name } : null;
}

/** `/channels/@me/friends`: abas Online, Todos, Pendentes, Bloqueados e "Adicionar amigo". */
export function FriendsPage() {
  const { t } = useT();
  const rels = useAllRelationships();
  const [tab, setTab] = useState<TabKey>("online");
  const statuses = usePresenceStore((s) => s.statuses);
  const [confirm, setConfirm] = useState<SocialConfirm | null>(null);
  const [inviting, setInviting] = useState<{ id: string; name: string } | null>(null);
  const actions = useSocialActions();

  const lists = useMemo(() => {
    const all = rels.data ?? [];
    const friends = all.filter((r) => r.type === "friend");
    return {
      friends,
      online: friends.filter((r) => (statuses[r.user.id] ?? "offline") !== "offline"),
      pending: [
        ...all.filter((r) => r.type === "incoming"),
        ...all.filter((r) => r.type === "outgoing"),
      ],
      incoming: all.filter((r) => r.type === "incoming").length,
      blocked: all.filter((r) => r.type === "blocked"),
    };
  }, [rels.data, statuses]);

  async function confirmed(c: SocialConfirm) {
    setConfirm(null);
    if (c.kind === "remove")
      await actions.remove(c.userId, t("people.person.removedFriend", { name: c.name }));
    else await actions.block(c.userId, t("people.person.blocked", { name: c.name }));
  }

  const rowProps = {
    actions,
    onConfirm: setConfirm,
    onInvite: (r: Relationship) => setInviting({ id: r.user.id, name: nameOf(r) }),
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b px-4">
        <NavToggle />
        <h1 className="font-semibold">{t("people.dmSidebar.friends")}</h1>
      </header>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as TabKey)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList
          variant="underline"
          aria-label={t("people.friends.sections")}
          className="shrink-0 overflow-x-auto px-2"
        >
          <TabsTrigger variant="underline" value="online">
            {t("people.friends.tabOnline")}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="all">
            {t("people.friends.tabAll")}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="pending">
            {t("people.friends.tabPending")}
            {lists.incoming > 0 ? (
              <CountBadge
                count={lists.incoming}
                aria-label={t("people.friends.incomingRequests", { count: lists.incoming })}
              />
            ) : null}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="blocked">
            {t("people.friends.tabBlocked")}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="add" className="ml-auto">
            <UserPlus /> <span className="max-sm:sr-only">{t("people.person.addFriend")}</span>
          </TabsTrigger>
        </TabsList>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {tab === "add" ? (
            <TabsContent value="add" className="max-w-xl">
              <AddFriend actions={actions} />
            </TabsContent>
          ) : rels.isPending ? (
            <ul aria-hidden className="flex flex-col gap-1">
              {[0, 1, 2].map((i) => (
                <li key={i} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="size-10 rounded-full" />
                  <Skeleton className="h-4 w-40" />
                </li>
              ))}
            </ul>
          ) : rels.isError ? (
            <ErrorState
              error={rels.error}
              onRetry={() => void rels.refetch()}
              retrying={rels.isFetching}
            />
          ) : (
            <>
              <TabsContent value="online">
                <List
                  items={lists.online}
                  label={t("people.friends.listOnline", { count: lists.online.length })}
                  empty={{
                    title: t("people.friends.emptyOnlineTitle"),
                    description:
                      lists.friends.length === 0
                        ? t("people.friends.emptyOnlineNoFriends")
                        : t("people.friends.emptyOnlineWaiting"),
                    action:
                      lists.friends.length === 0 ? (
                        <Button onClick={() => setTab("add")}>
                          <UserPlus /> {t("people.person.addFriend")}
                        </Button>
                      ) : undefined,
                  }}
                  {...rowProps}
                />
              </TabsContent>
              <TabsContent value="all">
                <List
                  items={lists.friends}
                  label={t("people.friends.listAll", { count: lists.friends.length })}
                  empty={{
                    title: t("people.friends.emptyAllTitle"),
                    description: t("people.friends.emptyAllDescription"),
                    action: (
                      <Button onClick={() => setTab("add")}>
                        <UserPlus /> {t("people.person.addFriend")}
                      </Button>
                    ),
                  }}
                  {...rowProps}
                />
              </TabsContent>
              <TabsContent value="pending">
                <List
                  items={lists.pending}
                  label={t("people.friends.listPending", { count: lists.pending.length })}
                  empty={{
                    title: t("people.friends.emptyPendingTitle"),
                    description: t("people.friends.emptyPendingDescription"),
                  }}
                  {...rowProps}
                />
              </TabsContent>
              <TabsContent value="blocked">
                <List
                  items={lists.blocked}
                  label={t("people.friends.listBlocked", { count: lists.blocked.length })}
                  empty={{
                    title: t("people.friends.emptyBlockedTitle"),
                    description: t("people.friends.emptyBlockedDescription"),
                  }}
                  {...rowProps}
                />
              </TabsContent>
            </>
          )}
        </div>
      </Tabs>
      <SocialConfirmDialog
        confirm={confirm}
        onCancel={() => setConfirm(null)}
        onConfirm={(c) => void confirmed(c)}
      />
      <InviteToServerDialog friend={inviting} onClose={() => setInviting(null)} />
    </div>
  );
}

type RowActions = ReturnType<typeof useSocialActions>;

function List({
  items,
  label,
  empty,
  ...row
}: {
  items: Relationship[];
  label: string;
  empty: { title: string; description: string; action?: React.ReactNode };
  actions: RowActions;
  onConfirm: (c: SocialConfirm) => void;
  onInvite: (r: Relationship) => void;
}) {
  if (items.length === 0)
    return (
      <EmptyState
        illustration={<EmptyChatIllustration className="h-36 w-auto" />}
        title={empty.title}
        description={empty.description}
        action={empty.action}
        className="py-10"
      />
    );
  return (
    <ul aria-label={label} className="flex max-w-3xl flex-col">
      {items.map((r) => (
        <li key={r.user.id}>
          <FriendRow rel={r} {...row} />
        </li>
      ))}
    </ul>
  );
}

function FriendRow({
  rel,
  actions,
  onConfirm,
  onInvite,
}: {
  rel: Relationship;
  actions: RowActions;
  onConfirm: (c: SocialConfirm) => void;
  onInvite: (r: Relationship) => void;
}) {
  const { t } = useT();
  const name = nameOf(rel);
  const dms = useDmActions();
  const activity = useVoiceActivity(rel.user.id);
  const status = usePresence(rel.user.id);
  const busy = actions.pending?.endsWith(`:${rel.user.id}`) ?? false;
  const isFriend = rel.type === "friend";
  const subtitle =
    rel.type === "incoming"
      ? t("people.friends.requestIncoming")
      : rel.type === "outgoing"
        ? t("people.friends.requestOutgoing")
        : rel.type === "blocked"
          ? t("people.friends.blockedLabel")
          : null;
  const iconBtn = "text-muted-foreground hover:text-foreground";
  return (
    <div className="group flex items-center gap-3 rounded-lg px-2 py-2 hover:bg-accent/50 focus-within:bg-accent/50">
      {isFriend ? (
        <StatusAvatar userId={rel.user.id} url={rel.user.avatar_url} name={name} size={40} />
      ) : (
        <StatusAvatar userId={undefined} url={rel.user.avatar_url} name={name} size={40} />
      )}
      <div className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate font-medium">{name}</span>
        <span className="truncate text-xs text-muted-foreground">
          @{rel.user.username}
          {" · "}
          {isFriend ? (
            <>
              <PresenceDot status={status} size={8} className="mr-1 inline-block ring-0" />
              {statusLabel[status]}
              <CustomStatusText userId={rel.user.id} prefix=" · " />
              {activity ? ` · ${t("people.friends.inVoice", activity)}` : ""}
            </>
          ) : (
            subtitle
          )}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {rel.type === "incoming" ? (
          <>
            <Button size="sm" loading={busy} onClick={() => void actions.accept(rel.user.id)}>
              <Check /> {t("people.friends.accept")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={t("people.friends.declineFrom", { name })}
              onClick={() => void actions.remove(rel.user.id)}
            >
              <X /> {t("people.person.decline")}
            </Button>
          </>
        ) : rel.type === "outgoing" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={t("people.friends.cancelTo", { name })}
            onClick={() => void actions.remove(rel.user.id)}
          >
            <X /> {t("people.person.cancelRequest")}
          </Button>
        ) : rel.type === "blocked" ? (
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() =>
              void actions.unblock(rel.user.id, t("people.person.unblocked", { name }))
            }
          >
            {t("people.person.unblock")}
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconBtn}
              aria-label={t("people.friends.messageAria", { name })}
              title={t("people.members.sendMessage")}
              disabled={dms.pending}
              onClick={() => void dms.message(rel.user.id)}
            >
              <MessageCircle />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconBtn}
              aria-label={t("people.person.callAria", { name })}
              title={t("people.person.call")}
              disabled={dms.pending}
              onClick={() => void dms.call(rel.user.id)}
            >
              <Phone />
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={iconBtn}
                  aria-label={t("people.friends.moreOptions", { name })}
                >
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onInvite(rel)}>
                  <Send /> {t("people.person.inviteToServer")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive-text"
                  onSelect={() => onConfirm({ kind: "remove", userId: rel.user.id, name })}
                >
                  <UserMinus /> {t("people.person.removeFriend")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive-text"
                  onSelect={() => onConfirm({ kind: "block", userId: rel.user.id, name })}
                >
                  <Ban /> {t("people.person.block")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </div>
    </div>
  );
}

function AddFriend({ actions }: { actions: RowActions }) {
  const { t } = useT();
  const { data: me } = useGetMe();
  const [username, setUsername] = useState("");
  const name = username.trim().replace(/^@/, "");
  const self = !!me && name.toLowerCase() === me.username.toLowerCase();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!name || self) return;
    if (await actions.request(name)) setUsername("");
  }
  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-3">
      <div>
        <h2 className="text-lg font-semibold">{t("people.person.addFriend")}</h2>
        <p className="text-sm text-muted-foreground">{t("people.friends.addDescription")}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="friend-username">{t("people.friends.username")}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="friend-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t("people.friends.usernamePlaceholder")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={self}
            aria-describedby={self ? "friend-self-hint" : undefined}
            className="sm:flex-1"
          />
          <Button type="submit" disabled={!name || self} loading={actions.pending === "request"}>
            <UserPlus /> {t("people.friends.sendRequest")}
          </Button>
        </div>
        {self ? (
          <p id="friend-self-hint" role="alert" className="text-xs text-destructive-text">
            {t("people.friends.self")}
          </p>
        ) : null}
      </div>
    </form>
  );
}
