import { describe, expect, it } from "vitest";
import { ALL_PERMISSIONS, hasPermission, Permission } from "./permissions";

describe("hasPermission", () => {
  it("confere o bit pedido", () => {
    const p = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
    expect(hasPermission(p, Permission.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(p, Permission.MANAGE_CHANNELS)).toBe(false);
  });

  it("ADMINISTRATOR vale para qualquer permissão", () => {
    expect(hasPermission(Permission.ADMINISTRATOR, Permission.KICK_MEMBERS)).toBe(true);
  });

  it("o dono tem tudo, mesmo sem bits", () => {
    expect(hasPermission(0, Permission.MANAGE_GUILD, { isOwner: true })).toBe(true);
    expect(hasPermission(0, Permission.MANAGE_GUILD, { isOwner: false })).toBe(false);
  });

  it("os valores seguem o SPEC 7.2", () => {
    expect(Permission.ADMINISTRATOR).toBe(1);
    expect(Permission.VIEW_CHANNEL).toBe(64);
    expect(Permission.VIDEO).toBe(4096);
    expect(Permission.BAN_MEMBERS).toBe(8192);
    expect(Permission.VIEW_AUDIT_LOG).toBe(262144);
    expect(Permission.MENTION_EVERYONE).toBe(524288);
    expect(ALL_PERMISSIONS).toBe(1048575);
  });
});
