import { describe, expect, it } from "vitest";
import { guild, member, role } from "@/test/fixtures";
import { groupMembers } from "./groups";

const g = guild("g1", "Alfa", {
  roles: [
    role("g1", "@everyone", 0, { is_everyone: true }),
    role("mod", "Moderadores", 5, { color: 0x3366ff }),
    role("vip", "VIP", 2),
  ],
});

describe("groupMembers", () => {
  const members = [
    member("1", "zeca", ["vip"]),
    member("2", "bia", ["mod", "vip"]),
    member("3", "ana", ["mod"]),
    member("4", "caio"),
    member("5", "duda", ["mod"]),
  ];
  const online = new Set(["1", "2", "3", "4"]);
  const groups = groupMembers(g, members, (id) => (online.has(id) ? "online" : "offline"));

  it("cargos com maior posição primeiro, depois Online e Offline", () => {
    expect(groups.map((x) => x.title)).toEqual(["Moderadores", "VIP", "Online", "Offline"]);
  });

  it("cada membro online fica sob o cargo mais alto, em ordem alfabética", () => {
    expect(groups[0]?.members.map((m) => m.username)).toEqual(["ana", "bia"]);
    expect(groups[1]?.members.map((m) => m.username)).toEqual(["zeca"]);
    expect(groups[2]?.members.map((m) => m.username)).toEqual(["caio"]);
  });

  it("quem está offline vai só para Offline, mesmo com cargo; invisível conta como offline", () => {
    expect(groups[3]?.members.map((m) => m.username)).toEqual(["duda"]);
    const hidden = groupMembers(g, [member("9", "fulano", ["mod"])], () => "invisible");
    expect(hidden.map((x) => x.key)).toEqual(["offline"]);
    expect(hidden[0]?.offline).toBe(true);
  });

  it("grupos vazios não aparecem", () => {
    expect(groupMembers(g, [], () => "online")).toEqual([]);
  });
});
