import { Permission } from "@spook/shared";
import { describe, expect, it } from "vitest";
import {
  allowedViewers,
  changes,
  isPrivate,
  keyOf,
  type Overwrite,
  permissionsForChannel,
  setPrivate,
  toDraft,
  triOf,
  withTri,
} from "./overwrites";

const everyone = (allow = 0, deny = 0): Overwrite => ({ type: "role", id: "g1", allow, deny });

describe("tri-state de permissões de canal", () => {
  it("lê allow, deny e herdar", () => {
    const o = everyone(Permission.SEND_MESSAGES, Permission.VIEW_CHANNEL);
    expect(triOf(o, "SEND_MESSAGES")).toBe("allow");
    expect(triOf(o, "VIEW_CHANNEL")).toBe("deny");
    expect(triOf(o, "SPEAK")).toBe("inherit");
  });

  it("trocar de estado limpa o outro lado (nunca allow e deny juntos)", () => {
    let o = everyone();
    o = withTri(o, "VIEW_CHANNEL", "deny");
    o = withTri(o, "VIEW_CHANNEL", "allow");
    expect(o).toMatchObject({ allow: Permission.VIEW_CHANNEL, deny: 0 });
    o = withTri(o, "VIEW_CHANNEL", "inherit");
    expect(o).toMatchObject({ allow: 0, deny: 0 });
  });

  it("mostra só as permissões do tipo do canal", () => {
    expect(permissionsForChannel(0).map((p) => p.name)).not.toContain("CONNECT");
    expect(permissionsForChannel(1).map((p) => p.name)).not.toContain("SEND_MESSAGES");
    expect(permissionsForChannel(1).map((p) => p.name)).toContain("SPEAK");
  });
});

describe("canal privado", () => {
  it("é o @everyone sem VIEW_CHANNEL e lista quem entra", () => {
    let d = toDraft([{ type: "role", id: "r1", allow: Permission.VIEW_CHANNEL, deny: 0 }]);
    expect(isPrivate(d, "g1")).toBe(false);
    d = setPrivate(d, "g1", true);
    expect(isPrivate(d, "g1")).toBe(true);
    expect(allowedViewers(d, "g1").map(keyOf)).toEqual(["role:r1"]);
    d = setPrivate(d, "g1", false);
    expect(isPrivate(d, "g1")).toBe(false);
  });
});

describe("changes", () => {
  it("devolve só o que mudou e zera o que saiu do rascunho", () => {
    const original = [
      everyone(0, Permission.VIEW_CHANNEL),
      { type: "member", id: "m1", allow: Permission.VIEW_CHANNEL, deny: 0 } as Overwrite,
    ];
    const d = toDraft(original);
    expect(changes(original, d)).toEqual([]);
    d.delete("member:m1");
    d.set("role:r2", { type: "role", id: "r2", allow: Permission.SEND_MESSAGES, deny: 0 });
    d.set("role:vazio", { type: "role", id: "vazio", allow: 0, deny: 0 });
    expect(changes(original, d)).toEqual([
      { type: "role", id: "r2", allow: Permission.SEND_MESSAGES, deny: 0 },
      { type: "member", id: "m1", allow: 0, deny: 0 },
    ]);
  });
});
