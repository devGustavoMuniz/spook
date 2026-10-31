import { beforeEach, describe, expect, it } from "vitest";
import { useGatewayStore } from "./store";

const s = () => useGatewayStore.getState();

beforeEach(() => s().reset());

describe("store do gateway", () => {
  it("começa fechado e sem sessão", () => {
    expect(s()).toMatchObject({ status: "closed", sessionId: null, userId: null, lastError: null });
  });

  it("guarda sessão e usuário; RESUMED troca só a sessão", () => {
    s().setSession("a", "11");
    s().setSession("b");
    expect(s()).toMatchObject({ sessionId: "b", userId: "11" });
  });

  it("o erro some quando a conexão volta, mas permanece enquanto fora do ar", () => {
    s().setError({ kind: "network", message: "x" });
    s().setStatus("reconnecting");
    expect(s().lastError).not.toBeNull();
    s().setStatus("connected");
    expect(s().lastError).toBeNull();
  });

  it("reset volta ao estado inicial", () => {
    s().setStatus("connected");
    s().setSession("a", "11");
    s().reset();
    expect(s()).toMatchObject({ status: "closed", sessionId: null, userId: null });
  });
});
