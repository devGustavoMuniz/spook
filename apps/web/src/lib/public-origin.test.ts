import { afterEach, describe, expect, it, vi } from "vitest";

const base = vi.hoisted(() => ({ value: "" }));
vi.mock("@spook/shared", () => ({ getApiBaseUrl: () => base.value }));

import { publicOrigin } from "./public-origin";

describe("publicOrigin", () => {
  afterEach(() => {
    base.value = "";
  });

  it("sem base da API (web) usa a origem da página", () => {
    expect(publicOrigin()).toBe(window.location.origin);
  });

  it("com base da API (desktop) usa o domínio público, não tauri.localhost", () => {
    base.value = "https://spook.dottadigital.com/";
    expect(publicOrigin()).toBe("https://spook.dottadigital.com");
  });

  it("base inválida cai para a origem da página", () => {
    base.value = "não é url";
    expect(publicOrigin()).toBe(window.location.origin);
  });
});
