import { Permission } from "@spook/shared";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it } from "vitest";
import { shouldNotify } from "@/features/notifications/in-app";
import { useNotificationPrefs } from "@/features/notifications/prefs";
import { useReadStateStore } from "@/features/notifications/read-state";
import {
  effective,
  isMutedEntry,
  useNotificationSettings,
} from "@/features/notifications/settings";
import { expiryFor } from "@/features/presence/actions";
import { displayStatus, liveCustom, usePresenceStore } from "@/features/presence/store";
import { channel, dm, guild, ME, member, messages, recipient } from "@/test/fixtures";
import { connectGateway, serverSends } from "@/test/gateway";
import { renderApp } from "@/test/render";
import type { Backend } from "@/test/server";

const BASE = Permission.VIEW_CHANNEL | Permission.SEND_MESSAGES;
const GEN = "g1-txt";
const DM1 = "1100";
const me = recipient(ME, "ana");
const bia = recipient("50", "bia", "Bia Souza");

function seed(s: Backend["state"]) {
  s.guilds.push(
    guild("g1", "Alfa", {
      permissions: BASE,
      channels: [
        channel("g1-cat", "Canais", 0, 2),
        { ...channel(GEN, "geral", 1, 0, "g1-cat"), guild_id: "g1" },
      ],
    }),
  );
  s.members.g1 = [member(ME, "ana"), member("50", "bia")];
  s.dms = [dm(DM1, [me, bia], { last_message_id: "1901" })];
  s.messages[GEN] = messages(GEN, 2, 1000);
  s.messages[DM1] = messages(DM1, 2, 1900);
}

const dmMsg = (id: string, content: string) => ({
  id,
  channel_id: DM1,
  author: { id: "50", username: "bia" },
  content,
  edited_at: null,
  created_at: "2026-10-31T12:00:00Z",
  attachments: [],
  mention_ids: [],
  reply_to: null,
  pinned: false,
});

async function open(extra: Partial<Parameters<typeof connectGateway>[2]> = {}) {
  const app = await renderApp(`/channels/g1/${GEN}`, { signedIn: true, seed });
  await screen.findByRole("navigation", { name: "Servidores" });
  const sock = await connectGateway(app.state.guilds, "sess-1", {
    private_channels: app.state.dms,
    ...extra,
  });
  await act(async () => {});
  return { ...app, sock };
}

beforeEach(() => {
  useReadStateStore.getState().reset();
  useNotificationSettings.getState().reset();
  usePresenceStore.getState().reset();
  useNotificationPrefs.getState().setMuted(false);
});

describe("regras puras", () => {
  const base = {
    authorId: "50",
    myId: ME,
    isDm: false,
    mentionIds: [] as string[],
    viewing: "away" as const,
    muted: false,
  };

  it("nível: tudo avisa sempre, só menções exige citação, nada nunca; DND e silêncio vencem", () => {
    expect(shouldNotify({ ...base, level: "all" })).toBe(true);
    expect(shouldNotify({ ...base, level: "mentions" })).toBe(false);
    expect(shouldNotify({ ...base, level: "mentions", mentionIds: [ME] })).toBe(true);
    expect(shouldNotify({ ...base, level: "none", mentionIds: [ME] })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, level: "mentions" })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true })).toBe(true); // padrão de DM = tudo
    expect(shouldNotify({ ...base, mentionIds: [ME] })).toBe(true); // padrão de servidor = menções
    expect(shouldNotify({ ...base, isDm: true, dnd: true })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, muted: true })).toBe(false);
  });

  it("herança: canal -> servidor -> padrão; silêncio do servidor vale para o canal; vencido não vale", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    const e = (scope: "guild" | "channel", id: string, extra = {}) => ({
      scope,
      target_id: id,
      muted: false,
      muted_until: null,
      level: null,
      suppress_everyone: false,
      ...extra,
    });
    const entries = {
      "guild:g": e("guild", "g", { level: "none" }),
      "channel:c": e("channel", "c", { level: "all" }),
    } as const;
    expect(effective(entries, { guildId: "g", channelId: "c" }, now).level).toBe("all");
    expect(effective(entries, { guildId: "g", channelId: "outro" }, now).level).toBe("none");
    expect(effective({}, { guildId: "g", channelId: "c" }, now).level).toBe("mentions");
    expect(effective({}, { channelId: "dm" }, now).level).toBe("all");
    const muted = { "guild:g": e("guild", "g", { muted: true }) };
    expect(effective(muted, { guildId: "g", channelId: "c" }, now).muted).toBe(true);
    const past = new Date(now - 1000).toISOString();
    const future = new Date(now + 1000).toISOString();
    expect(isMutedEntry(e("guild", "g", { muted: true, muted_until: past }), now)).toBe(false);
    expect(isMutedEntry(e("guild", "g", { muted: true, muted_until: future }), now)).toBe(true);
  });

  it("status: o meu invisível/dnd vence o automático; o dos outros vem do servidor", () => {
    const s = usePresenceStore.getState();
    s.setMine(ME, { status_pref: "invisible" });
    s.set(ME, "online");
    s.set("50", "dnd", { emoji: "🎧" });
    expect(displayStatus(usePresenceStore.getState(), ME)).toBe("invisible");
    expect(displayStatus(usePresenceStore.getState(), "50")).toBe("dnd");
    s.setMine(ME, { status_pref: "dnd" });
    expect(displayStatus(usePresenceStore.getState(), ME)).toBe("dnd");
    s.setMine(ME, { status_pref: "online" });
    s.set(ME, "idle");
    expect(displayStatus(usePresenceStore.getState(), ME)).toBe("idle");
  });

  it("status personalizado vencido some; expiração 'hoje' é a meia-noite local", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    expect(
      liveCustom({ text: "x", expires_at: new Date(now - 1).toISOString() }, now),
    ).toBeUndefined();
    expect(
      liveCustom({ text: "x", expires_at: new Date(now + 1).toISOString() }, now),
    ).toBeDefined();
    expect(liveCustom({ text: "x" }, now)).toBeDefined();
    expect(liveCustom({}, now)).toBeUndefined();
    const fixed = new Date(2026, 9, 31, 22, 0, 0);
    const end = new Date(expiryFor("today", fixed) as string);
    expect(end.getHours()).toBe(0);
    expect(end.getTime() - fixed.getTime()).toBe(2 * 3600_000);
    expect(expiryFor("never")).toBeUndefined();
    expect(Date.parse(expiryFor("30m", fixed) as string) - fixed.getTime()).toBe(30 * 60_000);
  });
});

describe("status", () => {
  it("o seletor muda para Não perturbar e Invisível; o ponto e o evento de outra aba acompanham", async () => {
    const user = userEvent.setup();
    const { sock, state } = await open();
    await user.click(await screen.findByRole("button", { name: /Mudar status/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Não perturbar/ }));
    await waitFor(() => expect(state.presencePatches).toEqual([{ status_pref: "dnd" }]));
    const panel = screen.getByRole("button", { name: /Status: Não perturbar/ });
    expect(panel).toBeInTheDocument();
    expect(document.querySelector('[data-status="dnd"]')).not.toBeNull();

    // Outra aba escolhe Invisível: o evento sincroniza esta.
    serverSends(sock, "PRESENCE_SELF_UPDATE", 2, { status_pref: "invisible" });
    expect(await screen.findByRole("button", { name: /Status: Invisível/ })).toBeInTheDocument();
  });

  it("status personalizado: diálogo envia texto, emoji e expiração; aparece no rodapé e na lista de membros", async () => {
    const user = userEvent.setup();
    const { sock, state } = await open({
      presences: [
        { user_id: "50", status: "online", custom_status: { text: "almoçando", emoji: "🍽️" } },
      ],
    });
    // O custom status de outra pessoa na lista de membros.
    const members = await screen.findByRole("complementary", { name: "Membros" });
    expect(await within(members).findByText("🍽️ almoçando")).toBeInTheDocument();

    await user.click(await screen.findByRole("button", { name: /Mudar status/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Definir status personalizado/ }));
    const dialog = await screen.findByRole("dialog", { name: "Status personalizado" });
    await user.type(within(dialog).getByLabelText("O que você está fazendo?"), "em foco");
    await user.click(within(dialog).getByRole("button", { name: "Usar 🎧" }));
    await user.click(within(dialog).getByRole("radio", { name: "1 hora" }));
    const before = Date.now();
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(state.presencePatches).toHaveLength(1));
    const body = state.presencePatches[0] as {
      custom_status: { text: string; emoji: string; expires_at: string };
    };
    expect(body.custom_status).toMatchObject({ text: "em foco", emoji: "🎧" });
    expect(Date.parse(body.custom_status.expires_at) - before).toBeGreaterThan(59 * 60_000);
    expect(Date.parse(body.custom_status.expires_at) - before).toBeLessThan(61 * 60_000);
    await waitFor(() => expect(screen.getAllByText("🎧 em foco").length).toBeGreaterThan(0));

    // Alguém muda o status em tempo real.
    serverSends(sock, "PRESENCE_UPDATE", 2, {
      user_id: "50",
      status: "dnd",
      custom_status: { text: "fones no ouvido" },
    });
    expect(await within(members).findByText("fones no ouvido")).toBeInTheDocument();
    serverSends(sock, "PRESENCE_UPDATE", 3, { user_id: "50", status: "online" });
    await waitFor(() => expect(within(members).queryByText("fones no ouvido")).toBeNull());
  });

  it("Não perturbar (pelo READY) suprime o toast, mas a contagem de não lidas continua", async () => {
    const { sock } = await open({ self_presence: { status_pref: "dnd" } });
    serverSends(sock, "MESSAGE_CREATE", 2, dmMsg("2000", "tem um minuto?"));
    await waitFor(() => expect(useReadStateStore.getState().channels[DM1]?.unread).toBe(1));
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(screen.queryByText("tem um minuto?")).toBeNull();
  });
});

describe("silenciar e nível de notificação", () => {
  it("silenciar a DM por 1 hora: PUT com prazo, indicador na lista, sem toast, contagem segue", async () => {
    const user = userEvent.setup();
    const { sock, state, router } = await open();
    await act(async () => {
      await router.navigate({ to: "/channels/@me" });
    });
    const nav = await screen.findByRole("navigation", { name: "Conversas" });
    await user.click(within(nav).getByRole("button", { name: /Opções de/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Silenciar esta conversa/ }));
    const before = Date.now();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Por 1 hora" }));
    await waitFor(() => expect(state.notifSettings).toHaveLength(1));
    const put = state.requests.find(
      (r) => r.method === "PUT" && r.path.includes("notification-settings"),
    );
    expect(put?.path).toBe(`/api/users/@me/notification-settings/channel/${DM1}`);
    const b = put?.body as { muted: boolean; muted_until: string };
    expect(b.muted).toBe(true);
    expect(Date.parse(b.muted_until) - before).toBeGreaterThan(59 * 60_000);
    expect(await within(nav).findByRole("img", { name: "Silenciado" })).toBeInTheDocument();

    serverSends(sock, "MESSAGE_CREATE", 2, dmMsg("2000", "psiu, silenciada"));
    await waitFor(() => expect(useReadStateStore.getState().channels[DM1]?.unread).toBe(1));
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(screen.queryByText("psiu, silenciada")).toBeNull();

    // Reativar volta a avisar.
    await user.click(within(nav).getByRole("button", { name: /Opções de/ }));
    await user.click(await screen.findByRole("menuitem", { name: /Reativar esta conversa/ }));
    await waitFor(() => expect(state.notifSettings).toHaveLength(0));
    serverSends(sock, "MESSAGE_CREATE", 3, dmMsg("2001", "agora avisa"));
    expect(await screen.findByText("agora avisa")).toBeInTheDocument();
  });

  it("nível 'Nada' no canal, vindo do READY e de outra aba, silencia o aviso de DM e mostra o indicador do servidor", async () => {
    const { sock } = await open({
      notification_settings: [
        { scope: "guild", target_id: "g1", muted: true, muted_until: null, level: null },
        { scope: "channel", target_id: DM1, muted: false, muted_until: null, level: "none" },
      ],
    });
    const rail = screen.getByRole("navigation", { name: "Servidores" });
    expect(within(rail).getByRole("img", { name: "Servidor silenciado" })).toBeInTheDocument();
    serverSends(sock, "MESSAGE_CREATE", 2, dmMsg("2000", "nível nada"));
    await act(async () => new Promise((r) => setTimeout(r, 100)));
    expect(screen.queryByText("nível nada")).toBeNull();
    // Outra aba volta o padrão: o evento limpa e o aviso volta.
    serverSends(sock, "NOTIFICATION_SETTINGS_UPDATE", 3, {
      scope: "channel",
      target_id: DM1,
      muted: false,
      muted_until: null,
      level: null,
    });
    serverSends(sock, "MESSAGE_CREATE", 4, dmMsg("2001", "voltou"));
    expect(await screen.findByText("voltou")).toBeInTheDocument();
  });

  it("canal silenciado fica esmaecido na lista e o menu oferece nível por canal", async () => {
    const user = userEvent.setup();
    const { state } = await open({
      notification_settings: [
        { scope: "channel", target_id: GEN, muted: true, muted_until: null, level: null },
      ],
    });
    const nav = await screen.findByRole("navigation", { name: "Canais" });
    const row = within(nav).getByRole("link", { name: /geral/ }).closest("[data-muted]");
    expect(row).not.toBeNull();
    await user.click(within(nav).getByRole("button", { name: "Opções de geral" }));
    await user.click(await screen.findByRole("menuitem", { name: /Configurações de notificação/ }));
    // jsdom não tem geometria: o mover do ponteiro fecha o submenu antes do clique; dispara o clique direto.
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Só menções" }));
    await waitFor(() =>
      expect(state.notifSettings).toEqual([
        expect.objectContaining({ target_id: GEN, muted: true, level: "mentions" }),
      ]),
    );
  });

  it("a página de notificações lista o que foi personalizado e restaura o padrão", async () => {
    const user = userEvent.setup();
    const app = await renderApp("/settings/notifications", {
      signedIn: true,
      seed: (s) => {
        seed(s);
        s.notifSettings = [
          { scope: "guild", target_id: "g1", muted: true, muted_until: null, level: "none" },
        ];
      },
    });
    useNotificationSettings.getState().replaceAll(app.state.notifSettings as never);
    expect(await screen.findByText("Silenciados e níveis")).toBeInTheDocument();
    const modal = await screen.findByRole("dialog", { name: "Configurações" });
    expect(await within(modal).findByText("Alfa")).toBeInTheDocument();
    expect(screen.getByText(/silenciado até você reativar · Nada/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Restaurar padrão" }));
    await waitFor(() => expect(app.state.notifSettings).toHaveLength(0));
    expect(await screen.findByText("Nada personalizado por enquanto.")).toBeInTheDocument();
  });
});
