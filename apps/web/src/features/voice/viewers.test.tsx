import type { VoiceStatePayload } from "@spook/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ViewersBadge } from "./viewers";

const names: Record<string, string> = {
  "2": "Bia",
  "3": "Caio",
  "4": "Dani",
  "5": "Edu",
  "6": "Fê",
  "7": "Gil",
};
const lookup = (id: string) => ({ name: names[id] ?? "Usuário" });
const base: VoiceStatePayload = {
  guild_id: "g1",
  channel_id: "c1",
  user_id: "1",
  self_mute: false,
  self_deaf: false,
  self_video: false,
  self_screen: true,
  screen_preview: false,
};

describe("ViewersBadge", () => {
  it("não aparece sem espectadores", () => {
    const { container } = render(
      <ViewersBadge state={{ ...base, viewer_count: 0 }} lookup={lookup} />,
    );
    expect(container).toBeEmptyDOMElement();
    const { container: c2 } = render(<ViewersBadge state={undefined} />);
    expect(c2).toBeEmptyDOMElement();
  });

  it("quem só vê a contagem (sem lista) lê 'Assistindo: N' e nenhum avatar", () => {
    render(<ViewersBadge state={{ ...base, viewer_count: 3 }} lookup={lookup} />);
    expect(screen.getByText("Assistindo: 3")).toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Quem está assistindo" })).toBeNull();
  });

  it("o transmissor vê avatares com os nomes (tooltip e leitor de tela) e '+N' além do limite", async () => {
    render(
      <ViewersBadge
        state={{ ...base, viewer_count: 7, viewers: ["2", "3", "4", "5", "6", "7"] }}
        lookup={lookup}
      />,
    );
    expect(screen.getByText("Assistindo: 7")).toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Quem está assistindo" });
    expect(list.querySelectorAll("button")).toHaveLength(4);
    expect(screen.getByText(/Bia, Caio, Dani, Edu, Fê, Gil/)).toBeInTheDocument(); // sr-only
    expect(screen.getByText("+3")).toBeInTheDocument();
    await userEvent.hover(screen.getByRole("button", { name: "Bia" }));
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Bia");
  });
});
