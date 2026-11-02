import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Lettering, LogoMark } from "@/components/brand";
import { ThemeProvider } from "@/components/theme-provider";
import { Avatar } from "@/components/ui/avatar";

function wrap(ui: React.ReactNode) {
  return render(<ThemeProvider>{ui}</ThemeProvider>);
}

describe("marca", () => {
  it("LogoMark usa o asset de fundo transparente, com o tamanho pedido e alt configurável", () => {
    wrap(<LogoMark size={36} glow />);
    const img = screen.getByRole("img", { name: "Spook" });
    expect(img.getAttribute("src")).toMatch(/mascote-fundo-(claro|escuro)/);
    expect(img.getAttribute("width")).toBe("36");
    expect(img.className).toContain("drop-shadow");
  });

  it("LogoMark decorativo (alt vazio) não entra na árvore de acessibilidade", () => {
    const { container } = wrap(<LogoMark alt="" />);
    expect(container.querySelector("img")?.getAttribute("alt")).toBe("");
  });

  it("Lettering mantém a proporção do asset", () => {
    wrap(<Lettering width={260} />);
    const img = screen.getByRole("img", { name: "SPOOK" });
    expect(img.getAttribute("width")).toBe("260");
    expect(img.getAttribute("height")).toBe("95");
  });

  it("Avatar com fallback de logo usa a marca transparente em círculo do tema", () => {
    wrap(<Avatar name="Spook" fallback="logo" size={40} />);
    const box = screen.getByRole("img", { name: "Avatar de Spook" });
    expect(box.className).toContain("rounded-full");
    expect(box.querySelector("img")?.getAttribute("src")).toMatch(/mascote-fundo/);
  });
});
