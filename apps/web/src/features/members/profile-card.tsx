import * as DialogPrimitive from "@radix-ui/react-dialog";
import type { MemberPayload } from "@spook/shared";
import { useGetMe } from "@spook/shared";
import { Copy, Gavel, Pencil, ShieldCheck, UserMinus } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { toast } from "sonner";
import { statusLabel } from "@/components/presence-dot";
import { useMediaQuery } from "@/components/shell";
import { Avatar, avatarColor } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { shownName } from "@/features/account/removed-user";
import { CustomStatusText } from "@/features/presence/custom-status-text";
import { usePresence } from "@/features/presence/store";
import { PersonActions } from "@/features/social/person-actions";
import { useT } from "@/i18n";
import { colorToHex } from "@/lib/colors";
import { formatDay } from "@/lib/format";
import { canBan, canKick, canManageRole, canNickname, type Guild, rolesOf } from "@/lib/guild";
import { useReadableRoleColor } from "@/lib/role-color";
import { memberName } from "./use-members";

/** O que se sabe de uma pessoa sem consultar o servidor (autor de mensagem, participante de DM, membro). */
export type ProfilePerson = {
  id: string;
  username: string;
  displayName?: string;
  avatarUrl?: string;
  bio?: string;
  pronouns?: string;
  bannerUrl?: string;
  /** Cor sólida do banner (RGB), usada quando não há imagem. */
  bannerColor?: number | null;
};

export const personOfMember = (m: MemberPayload): ProfilePerson => ({
  id: m.user_id,
  username: m.username,
  displayName: m.nickname || m.display_name || undefined,
  avatarUrl: m.avatar_url,
  bio: m.bio,
  pronouns: m.pronouns,
  bannerUrl: m.banner_url,
  bannerColor: m.banner_color,
});

const NARROW_QUERY = "(max-width: 639px)";
const CARD_WIDTH = 320;

/**
 * Cartão de perfil: popover ancorado ao clique (largura >= 640 px) ou bottom sheet (celular).
 * Só mostra o que a API tem: nome, @username, status, cargos, membro desde e as ações já existentes
 * (enviar mensagem, ligar, amizade, bloqueio, copiar ID, gerenciar cargos e expulsar quando há permissão).
 */
export function ProfileCard({
  person,
  anchor,
  guild,
  member,
  onClose,
  onRoles,
  onKick,
  onBan,
  onNick,
}: {
  person: ProfilePerson;
  anchor: HTMLElement | null;
  guild?: Guild;
  member?: MemberPayload;
  onClose: () => void;
  onRoles: (m: MemberPayload) => void;
  onKick: (m: MemberPayload) => void;
  onBan: (m: MemberPayload) => void;
  onNick: (m: MemberPayload, self: boolean) => void;
}) {
  const { t } = useT();
  const narrow = useMediaQuery(NARROW_QUERY);
  const { data: me } = useGetMe();
  const status = usePresence(person.id);
  const isMe = me?.id === person.id;
  const name = member ? memberName(member) : shownName(person.displayName, person.username);
  const color = useMemo(() => avatarColor(person.id), [person.id]);
  // O próprio perfil vem de /users/me (sempre completo); os outros, do membro do servidor.
  const bio = (isMe ? me?.bio : (member?.bio ?? person.bio)) || undefined;
  const pronouns = (isMe ? me?.pronouns : (member?.pronouns ?? person.pronouns)) || undefined;
  const bannerUrl = (isMe ? me?.banner_url : (member?.banner_url ?? person.bannerUrl)) || undefined;
  const bannerColor = isMe ? me?.banner_color : (member?.banner_color ?? person.bannerColor);

  const roles = useMemo(() => {
    if (!guild || !member) return [];
    const ids = new Set(member.role_ids ?? []);
    return rolesOf(guild)
      .filter((r) => !r.is_everyone && ids.has(r.id))
      .sort((a, b) => b.position - a.position);
  }, [guild, member]);

  const mayKick = !!(guild && member && me && canKick(guild, member, me.id));
  const mayBan = !!(guild && member && me && canBan(guild, member, me.id));
  const mayNick = !!(guild && member && me && canNickname(guild, member, me.id));
  const mayRoles =
    !!(guild && member && !isMe && member.user_id !== guild.owner_id) &&
    rolesOf(guild).some((r) => !r.is_everyone && canManageRole(guild, r));

  const style = useMemo<CSSProperties | undefined>(() => {
    if (narrow || !anchor || typeof window === "undefined") return undefined;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = Math.min(CARD_WIDTH, vw - 16);
    const preferLeft = r.left > vw / 2;
    let left = preferLeft ? r.left - w - 8 : r.right + 8;
    if (left < 8 || left + w > vw - 8) left = Math.min(Math.max(8, r.left), vw - w - 8);
    const top = Math.min(Math.max(8, r.top - 24), Math.max(8, vh - 440));
    return { top, left, width: w };
  }, [narrow, anchor]);

  async function copyId() {
    try {
      await navigator.clipboard.writeText(person.id);
      toast.success(t("people.members.idCopied"));
    } catch {
      toast.error(t("people.members.copyFailed"));
    }
  }

  return (
    <DialogPrimitive.Root open onOpenChange={(o) => !o && onClose()} modal={narrow}>
      <DialogPrimitive.Portal>
        {narrow ? (
          <DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-modal)] bg-overlay data-[state=open]:animate-overlay-in" />
        ) : null}
        <DialogPrimitive.Content
          aria-describedby={undefined}
          style={style}
          data-testid="profile-card"
          className={
            narrow
              ? "fixed inset-x-0 bottom-0 z-[var(--z-modal)] max-h-[85dvh] overflow-y-auto rounded-t-2xl border border-b-0 border-border bg-popover pb-[max(1rem,env(safe-area-inset-bottom))] text-popover-foreground shadow-xl outline-none data-[state=open]:animate-overlay-in"
              : "fixed z-[var(--z-popover)] origin-top-left overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl outline-none data-[state=open]:animate-pop-in"
          }
        >
          <DialogPrimitive.Title className="sr-only">
            {t("people.profile.title", { name })}
          </DialogPrimitive.Title>
          {narrow ? (
            <span aria-hidden className="mx-auto mt-2 block h-1 w-10 rounded-full bg-border" />
          ) : null}
          <div
            aria-hidden
            data-testid="profile-banner"
            className={`h-20 overflow-hidden ${narrow ? "mt-2" : ""}`}
            style={{
              background: bannerUrl
                ? undefined
                : bannerColor != null
                  ? colorToHex(bannerColor)
                  : `linear-gradient(120deg, ${color.from}, ${color.to})`,
            }}
          >
            {bannerUrl ? <img src={bannerUrl} alt="" className="size-full object-cover" /> : null}
          </div>
          <div className="relative px-4 pb-4">
            <Avatar
              url={person.avatarUrl}
              name={name}
              seed={person.id}
              size="lg"
              animation="always"
              status={status}
              statusLabel={statusLabel[status]}
              statusRingClassName="ring-4 ring-popover"
              className="-mt-8 ring-4 ring-popover"
            />
            <div className="mt-2">
              <p className="truncate text-lg leading-tight font-semibold">{name}</p>
              <p className="truncate text-sm text-muted-foreground">
                @{person.username}
                {pronouns ? <span> · {pronouns}</span> : null}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {statusLabel[status]}
                <CustomStatusText userId={person.id} prefix=" · " className="truncate" />
              </p>
            </div>
            {bio ? (
              <>
                <Separator className="my-3" />
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  {t("people.profile.about")}
                </h3>
                <p className="mt-1 text-sm break-words whitespace-pre-line">{bio}</p>
              </>
            ) : null}
            {roles.length > 0 ? (
              <>
                <Separator className="my-3" />
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  {t("people.profile.roles")}
                </h3>
                <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={t("people.profile.roles")}>
                  {roles.map((r) => (
                    <li key={r.id}>
                      <RoleBadge name={r.name} color={colorToHex(r.color)} />
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {member?.joined_at ? (
              <>
                <Separator className="my-3" />
                <h3 className="text-xs font-semibold text-muted-foreground uppercase">
                  {t("people.profile.memberSince")}
                </h3>
                <p className="mt-1 text-sm">
                  <time dateTime={member.joined_at}>{formatDay(member.joined_at)}</time>
                </p>
              </>
            ) : null}
            <Separator className="my-3" />
            <div className="flex flex-col gap-2">
              {!isMe ? (
                <PersonActions
                  userId={person.id}
                  username={person.username}
                  name={name}
                  onClose={onClose}
                />
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="sm" onClick={() => void copyId()}>
                  <Copy /> {t("people.members.copyUserId")}
                </Button>
                {mayRoles && member ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onClose();
                      onRoles(member);
                    }}
                  >
                    <ShieldCheck /> {t("people.members.manageRoles")}
                  </Button>
                ) : null}
                {mayNick && member ? (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      onClose();
                      onNick(member, isMe);
                    }}
                  >
                    <Pencil />{" "}
                    {isMe
                      ? t("people.profile.changeOwnNickname")
                      : t("people.members.changeNickname")}
                  </Button>
                ) : null}
                {mayKick && member ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive-text hover:bg-danger-soft"
                    onClick={() => {
                      onClose();
                      onKick(member);
                    }}
                  >
                    <UserMinus /> {t("people.members.kick")}
                  </Button>
                ) : null}
                {mayBan && member ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive-text hover:bg-danger-soft"
                    onClick={() => {
                      onClose();
                      onBan(member);
                    }}
                  >
                    <Gavel /> {t("people.members.ban")}
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

/** Cargo como selo: bolinha na cor do cargo e nome; texto na cor legível no tema (AA). */
export function RoleBadge({ name, color }: { name: string; color?: string }) {
  const readable = useReadableRoleColor(color);
  return (
    <span
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface-1 px-2 py-0.5 text-xs font-medium"
      style={
        readable
          ? { color: readable, borderColor: `color-mix(in srgb, ${color} 45%, transparent)` }
          : undefined
      }
    >
      <span
        aria-hidden
        className="size-2.5 shrink-0 rounded-full bg-muted-foreground"
        style={color ? { background: color } : undefined}
      />
      <span className="truncate">{name}</span>
    </span>
  );
}
