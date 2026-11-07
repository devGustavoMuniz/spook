import type { VoiceStatePayload } from "@spook/shared";
import { describe, expect, it } from "vitest";
import { joinDurations, markJoin, resetJoinPerf } from "./join-perf";
import { withProvisionalSelf } from "./provisional";

const other: VoiceStatePayload = {
  guild_id: "g",
  channel_id: "c",
  user_id: "2",
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen: false,
  screen_preview: false,
};
const base = { meId: "1", channelId: "c", guildId: "g", active: true };

describe("withProvisionalSelf", () => {
  it("acrescenta um item meu enquanto o servidor não confirmou, coerente com mudo/surdo locais", () => {
    const out = withProvisionalSelf([other], { ...base, selfMute: true });
    expect(out.map((p) => p.user_id)).toEqual(["1", "2"]);
    expect(out[0]).toMatchObject({ self_mute: true, self_deaf: false });
  });
  it("não duplica quando o estado real já chegou e não faz nada fora da chamada", () => {
    const mine = { ...other, user_id: "1" };
    expect(withProvisionalSelf([mine], base)).toEqual([mine]);
    expect(withProvisionalSelf([other], { ...base, active: false })).toEqual([other]);
    expect(withProvisionalSelf([other], { ...base, meId: undefined })).toEqual([other]);
  });
});

describe("join-perf", () => {
  it("click zera, a primeira marca de cada fase vale e as durações são relativas ao clique", () => {
    resetJoinPerf();
    markJoin("click");
    markJoin("token:end");
    markJoin("token:end");
    const d = joinDurations();
    expect(d.click).toBe(0);
    expect(typeof d["token:end"]).toBe("number");
    markJoin("click");
    expect(Object.keys(joinDurations())).toEqual(["click"]);
  });
});
