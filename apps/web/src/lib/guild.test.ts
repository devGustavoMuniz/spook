import { Permission } from "@spook/shared";
import { describe, expect, it } from "vitest";
import { channel, guild, role } from "@/test/fixtures";
import {
  canBan,
  canKick,
  canManageRole,
  canModerate,
  canNickname,
  groupChannels,
  moveChannel,
  myTopPosition,
} from "./guild";

describe("hierarquia", () => {
  const g = guild("g1", "Teste", {
    my_role_ids: ["mod"],
    permissions: Permission.MANAGE_ROLES | Permission.KICK_MEMBERS,
    roles: [
      role("adm", "Admin", 5),
      role("mod", "Moderador", 3),
      role("vip", "VIP", 1),
      role("g1", "@everyone", 0, { is_everyone: true }),
    ],
  });

  it("o cargo mais alto define a posição", () => {
    expect(myTopPosition(g)).toBe(3);
    expect(myTopPosition({ ...g, is_owner: true })).toBe(Number.POSITIVE_INFINITY);
  });

  it("só gerencia cargos estritamente abaixo do seu", () => {
    const [adm, mod, vip] = g.roles ?? [];
    expect(canManageRole(g, adm as never)).toBe(false);
    expect(canManageRole(g, mod as never)).toBe(false);
    expect(canManageRole(g, vip as never)).toBe(true);
  });

  it("não expulsa o dono, a si mesmo nem quem está acima", () => {
    const m = (id: string, roles: string[]) => ({
      user_id: id,
      guild_id: "g1",
      username: id,
      nickname: null,
      role_ids: roles,
      joined_at: "",
    });
    expect(canKick(g, m("x", ["vip"]), "me")).toBe(true);
    expect(canKick(g, m("x", ["adm"]), "me")).toBe(false);
    expect(canKick(g, m("me", []), "me")).toBe(false);
    expect(canKick(g, m("999", []), "me")).toBe(false); // dono (owner_id = 999)
  });
});

describe("moderação (ban, apelido, voz)", () => {
  const roles = [
    role("adm", "Admin", 5),
    role("mod", "Moderador", 3),
    role("vip", "VIP", 1),
    role("g1", "@everyone", 0, { is_everyone: true }),
  ];
  const m = (id: string, ids: string[] = []) => ({
    user_id: id,
    role_ids: ids,
  });
  const as = (permissions: number, mine = ["mod"]) =>
    guild("g1", "Teste", { my_role_ids: mine, roles, permissions });

  it("banir exige a permissão e respeita a hierarquia (administrador também)", () => {
    const withBan = as(Permission.BAN_MEMBERS);
    expect(canBan(withBan, m("x", ["vip"]) as never, "me")).toBe(true);
    expect(canBan(withBan, m("x", ["mod"]) as never, "me")).toBe(false); // cargo igual
    expect(canBan(withBan, m("x", ["adm"]) as never, "me")).toBe(false);
    expect(canBan(withBan, m("999") as never, "me")).toBe(false); // dono
    expect(canBan(as(0), m("x") as never, "me")).toBe(false);
    // ADMINISTRATOR concede a permissão, mas não passa por cima de cargo igual ou superior
    const admin = as(Permission.ADMINISTRATOR);
    expect(canBan(admin, m("x", ["adm"]) as never, "me")).toBe(false);
    expect(canBan(admin, m("x", ["vip"]) as never, "me")).toBe(true);
    // o dono pode tudo, menos nele mesmo
    const owner = { ...as(0), is_owner: true, owner_id: "me" };
    expect(canBan(owner, m("x", ["adm"]) as never, "me")).toBe(true);
    expect(canBan(owner, m("me") as never, "me")).toBe(false);
  });

  it("apelido: o meu com CHANGE_NICKNAME; o de outro com MANAGE_NICKNAMES e hierarquia", () => {
    expect(canNickname(as(Permission.CHANGE_NICKNAME), m("me") as never, "me")).toBe(true);
    expect(canNickname(as(0), m("me") as never, "me")).toBe(false);
    expect(canNickname(as(Permission.MANAGE_NICKNAMES), m("me") as never, "me")).toBe(true);
    expect(canNickname(as(Permission.CHANGE_NICKNAME), m("x") as never, "me")).toBe(false);
    expect(canNickname(as(Permission.MANAGE_NICKNAMES), m("x", ["vip"]) as never, "me")).toBe(true);
    expect(canNickname(as(Permission.MANAGE_NICKNAMES), m("x", ["adm"]) as never, "me")).toBe(
      false,
    );
  });

  it("canModerate serve a qualquer permissão (mutar, desconectar)", () => {
    const g = as(Permission.MUTE_MEMBERS);
    expect(canModerate(g, Permission.MUTE_MEMBERS, m("x", ["vip"]), "me")).toBe(true);
    expect(canModerate(g, Permission.DISCONNECT_MEMBERS, m("x", ["vip"]), "me")).toBe(false);
  });
});

describe("canais", () => {
  const g = guild("g1", "Teste", {
    channels: [
      channel("solto", "avisos", 0),
      channel("cat1", "Texto", 1, 2),
      channel("a", "a", 2, 0, "cat1"),
      channel("b", "b", 3, 0, "cat1"),
      channel("cat2", "Voz", 4, 2),
      channel("v", "sala", 5, 1, "cat2"),
    ],
  });

  it("agrupa por categoria, com canais soltos primeiro", () => {
    const groups = groupChannels(g);
    expect(groups.loose.map((c) => c.id)).toEqual(["solto"]);
    expect(groups.categories.map((c) => c.children.map((x) => x.id))).toEqual([["a", "b"], ["v"]]);
  });

  it("move um canal e renumera tudo de 0 a n", () => {
    expect(moveChannel(g, "b", -1)).toEqual([
      { id: "solto", position: 0, parent_id: null },
      { id: "cat1", position: 1, parent_id: null },
      { id: "b", position: 2, parent_id: "cat1" },
      { id: "a", position: 3, parent_id: "cat1" },
      { id: "cat2", position: 4, parent_id: null },
      { id: "v", position: 5, parent_id: "cat2" },
    ]);
  });

  it("move categorias entre si e recusa mover além das pontas", () => {
    expect(moveChannel(g, "cat2", -1)?.map((p) => p.id)).toEqual([
      "solto",
      "cat2",
      "v",
      "cat1",
      "a",
      "b",
    ]);
    expect(moveChannel(g, "a", -1)).toBeNull();
    expect(moveChannel(g, "v", 1)).toBeNull();
  });
});
