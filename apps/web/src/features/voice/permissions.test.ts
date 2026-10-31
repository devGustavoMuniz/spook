import { Permission } from "@spook/shared";
import { describe, expect, it } from "vitest";
import { guild } from "@/test/fixtures";
import { voicePermissions } from "./permissions";

const g = (permissions: number, is_owner = false) => guild("g", "Alfa", { permissions, is_owner });

describe("voicePermissions", () => {
  it("DM (sem servidor): tudo liberado", () => {
    expect(voicePermissions(null)).toEqual({ connect: true, speak: true, video: true });
  });
  it("sem nenhuma: nada", () => {
    expect(voicePermissions(g(Permission.VIEW_CHANNEL))).toEqual({
      connect: false,
      speak: false,
      video: false,
    });
  });
  it("CONNECT sem SPEAK/VIDEO: só ouve", () => {
    expect(voicePermissions(g(Permission.CONNECT))).toEqual({
      connect: true,
      speak: false,
      video: false,
    });
  });
  it("SPEAK e VIDEO são independentes", () => {
    const p = voicePermissions(g(Permission.CONNECT | Permission.VIDEO));
    expect(p).toMatchObject({ speak: false, video: true });
  });
  it("dono e administrador têm tudo", () => {
    expect(voicePermissions(g(0, true))).toEqual({ connect: true, speak: true, video: true });
    expect(voicePermissions(g(Permission.ADMINISTRATOR))).toEqual({
      connect: true,
      speak: true,
      video: true,
    });
  });
});
