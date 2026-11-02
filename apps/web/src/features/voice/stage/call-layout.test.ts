import { beforeEach, describe, expect, it } from "vitest";
import { loadCallLayout, pickAutoFocus, useCallLayoutStore, visibleTiles } from "./call-layout";
import type { TileModel } from "./participant-tile";

const t = (key: string, userId: string, x: Partial<TileModel> = {}): TileModel => ({
  key,
  userId,
  name: userId,
  kind: "person",
  local: false,
  ...x,
});
const video = {
  id: "v",
  identity: "x",
  kind: "camera",
  local: false,
  source: { attach: () => () => {} },
} as const;

beforeEach(() => {
  localStorage.clear();
  useCallLayoutStore.setState({ layout: "grid" });
});

describe("layout da chamada", () => {
  it("o padrão é a grade e valores inválidos voltam a ela", () => {
    expect(loadCallLayout()).toBe("grid");
    localStorage.setItem("spook:call-layout", "lixo");
    expect(loadCallLayout()).toBe("grid");
  });

  it("escolher persiste e alternar percorre grade, foco e ocultar", () => {
    useCallLayoutStore.getState().set("focus");
    expect(loadCallLayout()).toBe("focus");
    useCallLayoutStore.getState().cycle();
    expect(useCallLayoutStore.getState().layout).toBe("active");
    useCallLayoutStore.getState().cycle();
    expect(useCallLayoutStore.getState().layout).toBe("grid");
  });

  it("o foco automático prefere tela, depois câmera, depois quem fala", () => {
    const me = t("u:1", "1", { local: true });
    const a = t("u:2", "2");
    const b = t("u:3", "3");
    expect(pickAutoFocus([me, a, b], new Set(["3"]))?.key).toBe("u:3");
    expect(pickAutoFocus([me, a, b], new Set())?.key).toBe("u:2");
    expect(pickAutoFocus([me, a, t("u:3", "3", { video })], new Set())?.key).toBe("u:3");
    const screenTile = t("s:1", "2", { kind: "screen", video: { ...video, kind: "screen" } });
    expect(pickAutoFocus([me, t("u:4", "4", { video }), screenTile], new Set())?.key).toBe("s:1");
    expect(pickAutoFocus([me], new Set())?.key).toBe("u:1");
    expect(pickAutoFocus([], new Set())).toBeUndefined();
  });

  it("ocultar inativos mantém eu, vídeo, tela pendente e quem fala, e conta os ocultos", () => {
    const me = t("u:1", "1", { local: true });
    const quiet = t("u:2", "2");
    const talking = t("u:3", "3");
    const cam = t("u:4", "4", { video });
    const pending = t("s:p", "5", { kind: "screen", unwatched: true });
    const r = visibleTiles([me, quiet, talking, cam, pending], new Set(["3"]));
    expect(r.shown.map((x) => x.key)).toEqual(["u:1", "u:3", "u:4", "s:p"]);
    expect(r.hidden).toBe(1);
  });
});
