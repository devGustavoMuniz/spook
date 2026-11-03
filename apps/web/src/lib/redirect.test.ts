import { describe, expect, it } from "vitest";
import { authSearch, safeRedirect } from "./redirect";

describe("safeRedirect", () => {
  it("aceita só caminhos internos", () => {
    expect(safeRedirect("/invite/abc12345")).toBe("/invite/abc12345");
    expect(safeRedirect("//evil.example")).toBeUndefined();
    expect(safeRedirect("https://evil.example")).toBeUndefined();
    expect(safeRedirect("/\\evil.example")).toBeUndefined();
    expect(safeRedirect("/login")).toBeUndefined();
    expect(safeRedirect(42)).toBeUndefined();
  });

  it("authSearch descarta destino inválido", () => {
    expect(authSearch({ redirect: "//x" })).toEqual({});
    expect(authSearch({ redirect: "/settings/profile" })).toEqual({
      redirect: "/settings/profile",
    });
  });
});

describe("authSearch: social_error", () => {
  it("mantém só códigos conhecidos em formato seguro", () => {
    expect(authSearch({ social_error: "email_in_use" })).toEqual({ social_error: "email_in_use" });
    expect(authSearch({ social_error: "<script>", redirect: "/x" })).toEqual({ redirect: "/x" });
    expect(authSearch({ social_error: 42 })).toEqual({});
  });
});
