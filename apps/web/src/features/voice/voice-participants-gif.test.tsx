import type { VoiceStatePayload } from "@spook/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as frames from "@/components/ui/static-frame";
import { makeBackend, server } from "@/test/server";
import { VoiceParticipants } from "./voice-participants";

const GIF = "https://s3.test/avatars/50/9.gif?sig=abc";
const fakeFrame = { canvas: document.createElement("canvas"), width: 8, height: 8 };
const state = (id: string): VoiceStatePayload =>
  ({ user_id: id, channel_id: "v1", guild_id: "g1" }) as VoiceStatePayload;
const lookup = () => ({ name: "Bia", avatarUrl: GIF });

beforeEach(() => {
  server.use(...makeBackend({ signedIn: true }).handlers);
  vi.spyOn(frames, "paintCover").mockImplementation(() => {});
  vi.spyOn(frames, "peekStaticFrame").mockReturnValue(fakeFrame);
  vi.spyOn(frames, "loadStaticFrame").mockResolvedValue(fakeFrame);
});
afterEach(() => vi.restoreAllMocks());

const view = (speaking?: ReadonlySet<string>) => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VoiceParticipants
        participants={[state("50"), state("51")]}
        lookup={lookup}
        speaking={speaking}
      />
    </QueryClientProvider>,
  );
};

describe("avatar GIF na lista de participantes", () => {
  it("na minha chamada só anima quem está falando (mesmo sinal do anel verde)", async () => {
    view(new Set(["50"]));
    await waitFor(() => expect(document.querySelectorAll("canvas")).toHaveLength(2));
    const live = document.querySelectorAll("img[data-gif-live]");
    expect(live).toHaveLength(1);
    expect(live[0]?.closest("li")).toHaveAttribute("data-speaking", "true");
  });

  it("em canal que não é o meu (sem sinal de fala) todos ficam parados", async () => {
    view(undefined);
    await waitFor(() => expect(document.querySelectorAll("canvas")).toHaveLength(2));
    expect(document.querySelectorAll("img[data-gif-live]")).toHaveLength(0);
  });
});
