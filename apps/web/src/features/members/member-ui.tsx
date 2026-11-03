import type { MemberPayload } from "@spook/shared";
import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import type { Guild } from "@/lib/guild";
import { BanDialog, KickDialog, MemberRolesDialog, NicknameDialog } from "./member-dialogs";
import { ProfileCard, type ProfilePerson, personOfMember } from "./profile-card";
import { useGuildMembers } from "./use-members";

type MemberUi = {
  /** Abre o cartão de perfil ancorado em `anchor` (o botão clicado). */
  openProfile: (person: ProfilePerson, anchor: HTMLElement) => void;
  openRoles: (member: MemberPayload) => void;
  openKick: (member: MemberPayload) => void;
  openBan: (member: MemberPayload) => void;
  /** Apelido neste servidor: `self` abre o do próprio usuário. */
  openNick: (member: MemberPayload, self: boolean) => void;
};

const MemberUiContext = createContext<MemberUi | null>(null);

/** `null` fora de um provedor (nada abre). */
export const useMemberUi = () => useContext(MemberUiContext);

/**
 * Hospeda o cartão de perfil e os diálogos de moderação (cargos, expulsar) para a lista de membros e para o
 * chat. No servidor `guild` traz cargos e permissões; em DM fica sem `guild` (cartão só com nome, status e ações).
 */
export function MemberUiProvider({ guild, children }: { guild?: Guild; children: ReactNode }) {
  const [card, setCard] = useState<{ person: ProfilePerson; anchor: HTMLElement } | null>(null);
  const [rolesFor, setRolesFor] = useState<MemberPayload | null>(null);
  const [kicking, setKicking] = useState<MemberPayload | null>(null);
  const [banning, setBanning] = useState<MemberPayload | null>(null);
  const [nicking, setNicking] = useState<{ member: MemberPayload; self: boolean } | null>(null);
  const members = useGuildMembers(guild?.id ?? "", !!guild);
  const member = card
    ? members.data?.members?.find((m) => m.user_id === card.person.id)
    : undefined;

  const openProfile = useCallback(
    (person: ProfilePerson, anchor: HTMLElement) => setCard({ person, anchor }),
    [],
  );
  const value = useMemo<MemberUi>(
    () => ({
      openProfile,
      openRoles: setRolesFor,
      openKick: setKicking,
      openBan: setBanning,
      openNick: (member, self) => setNicking({ member, self }),
    }),
    [openProfile],
  );
  return (
    <MemberUiContext.Provider value={value}>
      {children}
      {card ? (
        <ProfileCard
          key={card.person.id}
          person={member ? personOfMember(member) : card.person}
          anchor={card.anchor}
          guild={guild}
          member={member}
          onClose={() => setCard(null)}
          onRoles={setRolesFor}
          onKick={setKicking}
          onBan={setBanning}
          onNick={(m, self) => setNicking({ member: m, self })}
        />
      ) : null}
      {guild ? (
        <>
          <MemberRolesDialog guild={guild} member={rolesFor} onClose={() => setRolesFor(null)} />
          <KickDialog guild={guild} member={kicking} onClose={() => setKicking(null)} />
          <BanDialog guild={guild} member={banning} onClose={() => setBanning(null)} />
          <NicknameDialog
            guild={guild}
            member={nicking?.member ?? null}
            self={nicking?.self ?? false}
            onClose={() => setNicking(null)}
          />
        </>
      ) : null}
    </MemberUiContext.Provider>
  );
}
