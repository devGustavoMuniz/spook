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
import { channelsOf } from "@/lib/guild";
import { type SocialConfirm, SocialConfirmDialog } from "./confirm";
import { useDmActions } from "./dm-actions";
import { useAllRelationships, useSocialActions } from "./hooks";
import { InviteToServerDialog } from "./invite-dialog";

type TabKey = "online" | "all" | "pending" | "blocked" | "add";

const nameOf = (r: Relationship) => shownName(r.user.display_name, r.user.username);

/** "Em voz em #canal · Servidor": só quando a pessoa está numa sala de um servidor que eu também vejo. */
function useVoiceActivity(userId: string): string | null {
  const state = useVoiceStatesStore((s) => s.byUser[userId]);
  const guilds = useListGuilds();
  if (!state?.guild_id || !state.channel_id) return null;
  const guild = guilds.data?.find((g) => g.id === state.guild_id);
  const channel = guild ? channelsOf(guild).find((c) => c.id === state.channel_id) : undefined;
  return guild && channel ? `Em voz em ${channel.name} · ${guild.name}` : null;
}

/** `/channels/@me/friends`: abas Online, Todos, Pendentes, Bloqueados e "Adicionar amigo". */
export function FriendsPage() {
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
    if (c.kind === "remove") await actions.remove(c.userId, `${c.name} foi removido dos amigos.`);
    else await actions.block(c.userId, `${c.name} foi bloqueado.`);
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
        <h1 className="font-semibold">Amigos</h1>
      </header>
      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as TabKey)}
        className="flex min-h-0 flex-1 flex-col gap-0"
      >
        <TabsList
          variant="underline"
          aria-label="Seções de amigos"
          className="shrink-0 overflow-x-auto px-2"
        >
          <TabsTrigger variant="underline" value="online">
            Online
          </TabsTrigger>
          <TabsTrigger variant="underline" value="all">
            Todos
          </TabsTrigger>
          <TabsTrigger variant="underline" value="pending">
            Pendentes
            {lists.incoming > 0 ? (
              <CountBadge
                count={lists.incoming}
                aria-label={`${lists.incoming} pedidos recebidos`}
              />
            ) : null}
          </TabsTrigger>
          <TabsTrigger variant="underline" value="blocked">
            Bloqueados
          </TabsTrigger>
          <TabsTrigger variant="underline" value="add" className="ml-auto">
            <UserPlus /> Adicionar amigo
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
                  label={`Amigos online, ${lists.online.length}`}
                  empty={{
                    title: "Ninguém online agora",
                    description:
                      lists.friends.length === 0
                        ? "Adicione amigos pelo nome de usuário para ver quem está online."
                        : "Quando seus amigos entrarem, eles aparecem aqui.",
                    action:
                      lists.friends.length === 0 ? (
                        <Button onClick={() => setTab("add")}>
                          <UserPlus /> Adicionar amigo
                        </Button>
                      ) : undefined,
                  }}
                  {...rowProps}
                />
              </TabsContent>
              <TabsContent value="all">
                <List
                  items={lists.friends}
                  label={`Todos os amigos, ${lists.friends.length}`}
                  empty={{
                    title: "Você ainda não tem amigos por aqui",
                    description: "Envie um pedido de amizade pelo nome de usuário.",
                    action: (
                      <Button onClick={() => setTab("add")}>
                        <UserPlus /> Adicionar amigo
                      </Button>
                    ),
                  }}
                  {...rowProps}
                />
              </TabsContent>
              <TabsContent value="pending">
                <List
                  items={lists.pending}
                  label={`Pedidos pendentes, ${lists.pending.length}`}
                  empty={{
                    title: "Nenhum pedido pendente",
                    description: "Pedidos que você enviar ou receber aparecem aqui.",
                  }}
                  {...rowProps}
                />
              </TabsContent>
              <TabsContent value="blocked">
                <List
                  items={lists.blocked}
                  label={`Bloqueados, ${lists.blocked.length}`}
                  empty={{
                    title: "Ninguém bloqueado",
                    description:
                      "Quem você bloquear fica aqui. Você pode desbloquear quando quiser.",
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
  const name = nameOf(rel);
  const dms = useDmActions();
  const activity = useVoiceActivity(rel.user.id);
  const status = usePresence(rel.user.id);
  const busy = actions.pending?.endsWith(`:${rel.user.id}`) ?? false;
  const isFriend = rel.type === "friend";
  const subtitle =
    rel.type === "incoming"
      ? "Pedido de amizade recebido"
      : rel.type === "outgoing"
        ? "Pedido de amizade enviado"
        : rel.type === "blocked"
          ? "Bloqueado"
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
              {activity ? ` · ${activity}` : ""}
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
              <Check /> Aceitar
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              aria-label={`Recusar pedido de ${name}`}
              onClick={() => void actions.remove(rel.user.id)}
            >
              <X /> Recusar
            </Button>
          </>
        ) : rel.type === "outgoing" ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            aria-label={`Cancelar pedido para ${name}`}
            onClick={() => void actions.remove(rel.user.id)}
          >
            <X /> Cancelar pedido
          </Button>
        ) : rel.type === "blocked" ? (
          <Button
            size="sm"
            variant="outline"
            loading={busy}
            onClick={() => void actions.unblock(rel.user.id, `${name} foi desbloqueado.`)}
          >
            Desbloquear
          </Button>
        ) : (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconBtn}
              aria-label={`Enviar mensagem para ${name}`}
              title="Enviar mensagem"
              disabled={dms.pending}
              onClick={() => void dms.message(rel.user.id)}
            >
              <MessageCircle />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className={iconBtn}
              aria-label={`Ligar para ${name}`}
              title="Ligar"
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
                  aria-label={`Mais opções de ${name}`}
                >
                  <MoreVertical />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => onInvite(rel)}>
                  <Send /> Convidar para servidor
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive-text"
                  onSelect={() => onConfirm({ kind: "remove", userId: rel.user.id, name })}
                >
                  <UserMinus /> Remover amigo
                </DropdownMenuItem>
                <DropdownMenuItem
                  className="text-destructive-text"
                  onSelect={() => onConfirm({ kind: "block", userId: rel.user.id, name })}
                >
                  <Ban /> Bloquear
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
        <h2 className="text-lg font-semibold">Adicionar amigo</h2>
        <p className="text-sm text-muted-foreground">
          Digite o nome de usuário da pessoa. Se ela já tiver pedido a sua amizade, vocês viram
          amigos na hora.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="friend-username">Nome de usuário</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Input
            id="friend-username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="ex.: maria_souza"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            aria-invalid={self}
            aria-describedby={self ? "friend-self-hint" : undefined}
            className="sm:flex-1"
          />
          <Button type="submit" disabled={!name || self} loading={actions.pending === "request"}>
            <UserPlus /> Enviar pedido
          </Button>
        </div>
        {self ? (
          <p id="friend-self-hint" role="alert" className="text-xs text-destructive-text">
            Você não pode adicionar a si mesmo.
          </p>
        ) : null}
      </div>
    </form>
  );
}
