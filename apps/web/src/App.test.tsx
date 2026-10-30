import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

afterEach(() => vi.restoreAllMocks());

describe("App", () => {
  it("mostra backend online quando /healthz responde ok", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ status: "ok" })));
    render(<App />);
    expect(await screen.findByText("Backend online")).toBeInTheDocument();
  });

  it("mostra indisponível quando a requisição falha", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("rede"));
    render(<App />);
    expect(await screen.findByText("Backend indisponível")).toBeInTheDocument();
  });
});
