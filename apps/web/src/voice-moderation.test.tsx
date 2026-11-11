import { Permission } from "@spook/shared";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { reconcileVoiceUpdate, resetVoiceController } from "@/features/voice/controller";
import { setVoiceEngineFactory } from "@/features/voice/engine-provider";
import { useVoiceStatesStore, useVoiceStore } from "@/features/voice/store";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { guild, ME, member, role } from "@/test/fixtures";
import { connectGateway, serverSends, voiceState } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const VOICE = "g1-voz";
const FULL =
  Permission.VIEW_CHANNEL |
  Permission.SEND_MESSAGES |
  Permission.CONNECT |
  Permission.SPEAK |
  Permission.VIDEO;
const roles = [
  role("mod", "Mod", 5),
  role("adm", "Admin", 9),
  role("g1", "@everyone", 0, { is_everyone: true }),
];

let fake: FakeVoiceEngine;
beforeEach(() => {
  fake = new FakeVoiceEngine();
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
  useVoiceStatesStore.getState().reset();
});

function seed(extra: number) {
  return (s: Backend["state"]) => {
    s.guilds.push(guild("g1", "Alfa", { roles, my_role_ids: ["mod"], permissions: FULL | extra }));
    s.members.g1 = [
      member(ME, "ana", ["mod"]),
      member("50", "bia"),
      member("60", "chefe", ["adm"]),
    ];
  };
}

async function start(extra: number, states: ReturnType<typeof voiceState>[]) {
  const app = await renderApp("/channels/g1/g1-txt", { signedIn: true, seed: seed(extra) });
  const nav = await screen.findByRole("navigation", { name: "Canais" });
  const sock = await connectGateway(app.state.guilds, "s1", { voice_states: states });
  return { ...app, sock, nav };
}

async function open(extra: number, states = [voiceState("50", VOICE), voiceState("60", VOICE)]) {
  const app = await start(extra, states);
  const list = await within(app.nav).findByRole("list", { name: "Conectados" });
  return { ...app, list };
}

describe("moderação de voz na lista de conectados", () => {
  it("mutar e desconectar aparecem só com a permissão e para quem está abaixo", async () => {
    const user = userEvent.setup();
    const { list, state } = await open(Permission.MUTE_MEMBERS | Permission.DISCONNECT_MEMBERS);
    await within(list).findByText("bia");
    // quem está acima de mim (chefe) não tem menu de moderação
    expect(within(list).queryByRole("button", { name: "Moderar chefe na voz" })).toBeNull();

    await user.click(within(list).getByRole("button", { name: "Moderar bia na voz" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mutar pelo servidor" }));
    await waitFor(() =>
      expect(state.moderation.voiceMutes).toEqual([{ userId: "50", muted: true }]),
    );

    await user.click(within(list).getByRole("button", { name: "Moderar bia na voz" }));
    await user.click(await screen.findByRole("menuitem", { name: "Desconectar da chamada" }));
    await waitFor(() =>
      expect(state.moderation.disconnects).toEqual([{ channelId: VOICE, userId: "50" }]),
    );
  });

  it("só MUTE_MEMBERS: não oferece desconectar", async () => {
    const user = userEvent.setup();
    const { list } = await open(Permission.MUTE_MEMBERS);
    await user.click(await within(list).findByRole("button", { name: "Moderar bia na voz" }));
    expect(
      await screen.findByRole("menuitem", { name: "Mutar pelo servidor" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Desconectar da chamada" })).toBeNull();
  });

  it("sem permissão nenhuma o menu não existe", async () => {
    const { list } = await open(0);
    await within(list).findByText("bia");
    expect(within(list).queryByRole("button", { name: /Moderar/ })).toBeNull();
  });

  it("mostra o ícone de mutado pelo servidor e oferece liberar", async () => {
    const user = userEvent.setup();
    const { list, state } = await open(Permission.MUTE_MEMBERS, [
      voiceState("50", VOICE, { server_muted: true, self_mute: true }),
    ]);
    const row = (await within(list).findByText("bia")).closest("li") as HTMLElement;
    expect(within(row).getByRole("img", { name: "Mutado pelo servidor" })).toBeInTheDocument();
    // o mute local não duplica o ícone
    expect(within(row).queryByRole("img", { name: "Microfone silenciado" })).toBeNull();
    await user.click(within(row).getByRole("button", { name: "Moderar bia na voz" }));
    await user.click(await screen.findByRole("menuitem", { name: "Liberar o microfone" }));
    await waitFor(() =>
      expect(state.moderation.voiceMutes).toEqual([{ userId: "50", muted: false }]),
    );
  });
});

describe("quando o moderador me muta", () => {
  it("o microfone é desligado e não dá para desmutar até ser liberado", async () => {
    const user = userEvent.setup();
    const { nav, sock } = await start(0, []);
    await user.click(within(nav).getByRole("button", { name: /Geral \(canal de voz/ }));
    const bar = await screen.findByRole("region", { name: "Controles de voz" });
    await within(bar).findByText("Voz conectada");
    expect(fake.mic).toBe(true);

    // o servidor confirma a entrada e depois me muta
    serverSends(sock, "VOICE_STATE_UPDATE", 2, voiceState(ME, VOICE));
    serverSends(sock, "VOICE_STATE_UPDATE", 3, voiceState(ME, VOICE, { server_muted: true }));
    await waitFor(() => expect(fake.mic).toBe(false));
    // o LiveKit derruba a faixa ao revogar a permissão: a nossa é descartada, para a próxima ligada publicar uma nova
    await waitFor(() => expect(fake.calls).toContain("mic:reset"));
    expect(fake.calls.indexOf("mic:reset")).toBeGreaterThan(fake.calls.lastIndexOf("mic:false"));
    expect(useVoiceStore.getState().selfMute).toBe(true);
    expect(await screen.findByText(/Um moderador mutou você/)).toBeInTheDocument();

    // tentar desmutar: avisa e continua mudo
    await user.click(within(bar).getByRole("button", { name: /^(Ativar|Silenciar) microfone$/ }));
    expect(useVoiceStore.getState().selfMute).toBe(true);
    expect(fake.mic).toBe(false);

    // liberado: o botão volta a funcionar
    serverSends(sock, "VOICE_STATE_UPDATE", 4, voiceState(ME, VOICE, { server_muted: false }));
    expect(await screen.findByText(/liberou o seu microfone/)).toBeInTheDocument();
    await user.click(within(bar).getByRole("button", { name: /^(Ativar|Silenciar) microfone$/ }));
    await waitFor(() => expect(useVoiceStore.getState().selfMute).toBe(false));
    act(() => reconcileVoiceUpdate(ME, voiceState(ME, null)));
  });
});
