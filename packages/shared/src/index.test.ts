import { describe, expect, it } from "vitest";
import type { HealthStatus } from "./index";

describe("shared", () => {
  it("expõe o tipo HealthStatus", () => {
    const s: HealthStatus = { status: "ok" };
    expect(s.status).toBe("ok");
  });
});
