import type { DetailPayload, GatewayEvent, MessagePayload } from "@spook/shared";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dmsOf } from "@/lib/dm-cache";
import { addMessage, flattenPages, type MessagePages } from "@/lib/message-cache";
import { queryKeys } from "@/lib/queryKeys";
import { channel, dm, guild, ME, member, messages, recipient, role } from "@/test/fixtures";
import { useNotificationPrefs } from "../notifications/prefs";
import { useReadStateStore } from "../notifications/read-state";
import type { Viewing } from "../notifications/viewport";
import { usePresenceStore } from "../presence/store";
import { useTypingStore } from "../typing/store";
import {
  applyGatewayEvent,
  applyReady,
  type GatewayEffects,
  refreshAfterGap,
} from "./cache-bindings";

const CH = "g1-txt";
let qc: QueryClient;
let fx: GatewayEffects & {
  leftGuild: ReturnType<typeof vi.fn>;
  channelGone: ReturnType<typeof vi.fn>;
  dmGone: ReturnType<typeof vi.fn>;
};
let viewing: Viewing = "away";
let where: { guildId?: string; channelId?: string };

const send = (ev: GatewayEvent) => applyGatewayEvent(qc, fx, ev);
const guildsData = () => qc.getQueryData<DetailPayload[]>(queryKeys.guilds()) ?? [];
const g1 = () => guildsData().find((g) => g.id === "g1") as DetailPayload;
const invalidated = (key: readonly unknown[]) => qc.getQueryState(key)?.isInvalidated ?? false;
const history = () => flattenPages(qc.getQueryData<MessagePages>(queryKeys.messages(CH)));

function msg(id: string, content = `msg ${id}`, author = "50"): MessagePayload {
  return {
    id,
    channel_id: CH,
    author: { id: author, username: author === ME ? "ana" : "bia" },
    content,
    edited_at: null,
    created_at: "2026-10-31T12:00:00Z",
    attachments: [],
    mention_ids: [],
    kind: "default",
    mention_everyone: false,
    mention_here: false,
    mention_roles: [],
    reply_to: null,
    pinned: false,
  };
}

beforeEach(() => {
  usePresenceStore.getState().reset();
  useTypingStore.getState().reset();
  useReadStateStore.getState().reset();
  useNotificationPrefs.getState().setMuted(false);
  viewing = "away";
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  where = { guildId: "g1", channelId: CH };
  fx = {
    myId: () => ME,
    location: () => where,
    leftGuild: vi.fn(),
    channelGone: vi.fn(),
    dmGone: vi.fn(),
    viewing: () => viewing,
    notify: vi.fn(),
  };
  qc.setQueryData(queryKeys.guilds(), [
    guild("g1", "Alfa", {
      my_role_ids: ["r-mod"],
      roles: [
        role("r-mod", "Mod", 1, { guild_id: "g1" }),
        role("g1", "@everyone", 0, { is_everyone: true, guild_id: "g1" }),
      ],
    }),
  ]);
  qc.setQueryData<MessagePages>(queryKeys.messages(CH), {
    pageParams: [undefined],
    pages: [{ messages: messages(CH, 3).reverse(), has_more: false }],
  });
});

describe("mensagens", () => {
  it("MESSAGE_CREATE de outro usuário entra no histórico aberto", () => {
    send({ t: "MESSAGE_CREATE", d: msg("2000", "oi do outro") });
    expect(history().map((m) => m.id)).toEqual(["1000", "1001", "1002", "2000"]);
  });

  it("a mensagem própria (já adicionada pela resposta do POST) não duplica; a ordem inversa também não", () => {
    const own = msg("2000", "minha", ME);
    addMessage(qc, CH, own);
    send({ t: "MESSAGE_CREATE", d: own });
    expect(history().filter((m) => m.id === "2000")).toHaveLength(1);

    // evento antes da resposta do POST
    send({ t: "MESSAGE_CREATE", d: msg("2001", "minha 2", ME) });
    addMessage(qc, CH, msg("2001", "minha 2", ME));
    expect(history().filter((m) => m.id === "2001")).toHaveLength(1);
  });

  it("MESSAGE_UPDATE troca o conteúdo e MESSAGE_DELETE remove", () => {
    send({
      t: "MESSAGE_UPDATE",
      d: { ...msg("1001"), content: "editada", edited_at: "2026-10-31T12:05:00Z" },
    });
    expect(history().find((m) => m.id === "1001")?.content).toBe("editada");
    send({ t: "MESSAGE_DELETE", d: { id: "1001", channel_id: CH, guild_id: "g1" } });
    expect(history().map((m) => m.id)).toEqual(["1000", "1002"]);
  });

  it("evento de um canal cujo histórico não está no cache é ignorado", () => {
    send({ t: "MESSAGE_CREATE", d: { ...msg("3000"), channel_id: "outro" } });
    expect(qc.getQueryData(queryKeys.messages("outro"))).toBeUndefined();
  });
});

describe("servidores, canais e cargos", () => {
  it("GUILD_CREATE entra na lista sem duplicar; GUILD_UPDATE troca o nome", () => {
    const novo = guild("g2", "Beta");
    send({ t: "GUILD_CREATE", d: novo });
    send({ t: "GUILD_CREATE", d: novo });
    expect(guildsData().map((g) => g.id)).toEqual(["g1", "g2"]);
    send({ t: "GUILD_UPDATE", d: { ...g1(), name: "Alfa 2" } });
    expect(g1().name).toBe("Alfa 2");
    expect(g1().channels).toHaveLength(3); // canais e cargos preservados
    expect(invalidated(queryKeys.guilds())).toBe(false);
  });

  it("GUILD_UPDATE que troca o dono refaz a lista (is_owner e permissões mudam)", () => {
    send({ t: "GUILD_UPDATE", d: { ...g1(), owner_id: "77" } });
    expect(invalidated(queryKeys.guilds())).toBe(true);
  });

  it("GUILD_DELETE tira o servidor e leva o usuário embora se estava nele", () => {
    send({ t: "GUILD_DELETE", d: { id: "g1" } });
    expect(guildsData()).toEqual([]);
    expect(fx.leftGuild).toHaveBeenCalledWith("Alfa");
    // eco do evento (já removido pelo app): nada a fazer
    send({ t: "GUILD_DELETE", d: { id: "g1" } });
    expect(fx.leftGuild).toHaveBeenCalledTimes(1);
  });

  it("GUILD_DELETE de outro servidor não navega", () => {
    send({ t: "GUILD_CREATE", d: guild("g2", "Beta") });
    send({ t: "GUILD_DELETE", d: { id: "g2" } });
    expect(guildsData().map((g) => g.id)).toEqual(["g1"]);
    expect(fx.leftGuild).not.toHaveBeenCalled();
  });

  it("CHANNEL_CREATE/UPDATE mantêm a lista por posição; CHANNEL_DELETE do canal aberto navega", () => {
    send({
      t: "CHANNEL_CREATE",
      d: { ...channel("g1-novo", "novo", 4, 0, "g1-cat"), guild_id: "g1" },
    });
    send({
      t: "CHANNEL_UPDATE",
      d: { ...channel("g1-voz", "Voz", 3, 1, "g1-cat"), guild_id: "g1" },
    });
    expect(g1().channels?.map((c) => c.id)).toEqual(["g1-cat", "g1-txt", "g1-voz", "g1-novo"]);
    expect(g1().channels?.find((c) => c.id === "g1-voz")?.name).toBe("Voz");

    send({ t: "CHANNEL_DELETE", d: { ...channel(CH, "geral", 1, 0, "g1-cat"), guild_id: "g1" } });
    expect(g1().channels?.some((c) => c.id === CH)).toBe(false);
    expect(fx.channelGone).toHaveBeenCalledWith("g1", "geral");
    expect(qc.getQueryData(queryKeys.messages(CH))).toBeUndefined();
  });

  it("CHANNEL_DELETE de outro canal não navega", () => {
    send({ t: "CHANNEL_DELETE", d: { ...channel("g1-voz", "Geral", 2, 1), guild_id: "g1" } });
    expect(fx.channelGone).not.toHaveBeenCalled();
  });

  it("ROLE_CREATE entra ordenado; ROLE_UPDATE de cargo que não é meu não refaz a lista", () => {
    send({ t: "ROLE_CREATE", d: role("r-novo", "Novo", 5, { guild_id: "g1" }) });
    expect(g1().roles?.map((r) => r.id)).toEqual(["r-novo", "r-mod", "g1"]);
    send({ t: "ROLE_UPDATE", d: role("r-novo", "Novo 2", 5, { guild_id: "g1" }) });
    expect(g1().roles?.[0]?.name).toBe("Novo 2");
    expect(invalidated(queryKeys.guilds())).toBe(false);
  });

  it("ROLE_UPDATE do meu cargo ou do @everyone invalida o servidor", () => {
    send({ t: "ROLE_UPDATE", d: role("r-mod", "Mod", 1, { guild_id: "g1", permissions: 0 }) });
    expect(invalidated(queryKeys.guilds())).toBe(true);
    qc.setQueryData(queryKeys.guilds(), guildsData());
    expect(invalidated(queryKeys.guilds())).toBe(false);
    send({
      t: "ROLE_UPDATE",
      d: role("g1", "@everyone", 0, { guild_id: "g1", is_everyone: true }),
    });
    expect(invalidated(queryKeys.guilds())).toBe(true);
  });

  it("ROLE_DELETE do meu cargo some do cache, dos membros, e invalida o servidor", () => {
    qc.setQueryData(queryKeys.members("g1"), {
      members: [{ ...member(ME, "ana", ["r-mod"]), guild_id: "g1" }],
      has_more: false,
    });
    send({ t: "ROLE_DELETE", d: { guild_id: "g1", role_id: "r-mod" } });
    expect(g1().roles?.map((r) => r.id)).toEqual(["g1"]);
    expect(g1().my_role_ids).toEqual([]);
    expect(invalidated(queryKeys.guilds())).toBe(true);
    const members = qc.getQueryData<{ members: { role_ids: string[] }[] }>(queryKeys.members("g1"));
    expect(members?.members[0]?.role_ids).toEqual([]);
  });
});

describe("membros", () => {
  const withMembers = () =>
    qc.setQueryData(queryKeys.members("g1"), {
      members: [{ ...member(ME, "ana"), guild_id: "g1" }],
      has_more: false,
    });
  const ids = () =>
    qc
      .getQueryData<{ members: { user_id: string }[] }>(queryKeys.members("g1"))
      ?.members.map((m) => m.user_id);

  it("ADD, UPDATE e REMOVE mexem na lista de membros carregada", () => {
    withMembers();
    const bia = { ...member("50", "bia"), guild_id: "g1" };
    send({ t: "GUILD_MEMBER_ADD", d: bia });
    send({ t: "GUILD_MEMBER_ADD", d: bia });
    expect(ids()).toEqual([ME, "50"]);
    send({ t: "GUILD_MEMBER_UPDATE", d: { ...bia, nickname: "bi" } });
    expect(
      qc.getQueryData<{ members: { nickname: string }[] }>(queryKeys.members("g1"))?.members[1]
        ?.nickname,
    ).toBe("bi");
    expect(invalidated(queryKeys.guilds())).toBe(false); // não sou eu
    send({ t: "GUILD_MEMBER_REMOVE", d: { guild_id: "g1", user_id: "50" } });
    expect(ids()).toEqual([ME]);
  });

  it("sem lista de membros carregada, não cria cache", () => {
    send({ t: "GUILD_MEMBER_ADD", d: { ...member("50", "bia"), guild_id: "g1" } });
    expect(qc.getQueryData(queryKeys.members("g1"))).toBeUndefined();
  });

  it("GUILD_MEMBER_UPDATE do próprio usuário invalida o servidor (permissões e canais mudam)", () => {
    send({ t: "GUILD_MEMBER_UPDATE", d: { ...member(ME, "ana", []), guild_id: "g1" } });
    expect(invalidated(queryKeys.guilds())).toBe(true);
  });

  it("GUILD_MEMBER_REMOVE do próprio usuário equivale a sair do servidor", () => {
    send({ t: "GUILD_MEMBER_REMOVE", d: { guild_id: "g1", user_id: ME } });
    expect(guildsData()).toEqual([]);
    expect(fx.leftGuild).toHaveBeenCalledWith("Alfa");
  });
});

describe("lacuna de eventos", () => {
  it("refreshAfterGap invalida servidores, históricos (também os inativos) e membros", () => {
    qc.setQueryData(queryKeys.members("g1"), { members: [], has_more: false });
    refreshAfterGap(qc);
    expect(invalidated(queryKeys.guilds())).toBe(true);
    expect(invalidated(queryKeys.messages(CH))).toBe(true);
    expect(invalidated(queryKeys.members("g1"))).toBe(true);
  });
});

// ---- Fase 4: DMs, presença e "digitando…" ----

const DM1 = "1100"; // 1:1 com a bia (50)
const GRP = "1200"; // grupo meu, com bia e caio
const bia = recipient("50", "bia");
const me = recipient(ME, "ana");
const caio = recipient("60", "caio");
const dmMsg = (channelId: string, id: string, author = "50"): MessagePayload => ({
  ...msg(id, `dm ${id}`, author),
  channel_id: channelId,
});
const typing = (ch: string) => useTypingStore.getState().byChannel[ch] ?? [];
const dmIds = () => dmsOf(qc).map((c) => c.id);

describe("DMs", () => {
  beforeEach(() => {
    applyReady(
      qc,
      {
        guilds: guildsData(),
        private_channels: [
          dm(DM1, [me, bia]),
          dm(GRP, [me, bia, caio], { type: 4, owner_id: ME, name: "Estudo" }),
        ],
      },
      fx,
    );
  });

  it("o READY semeia a lista de DMs com os participantes", () => {
    expect(dmIds().sort()).toEqual([DM1, GRP]);
    expect(dmsOf(qc).find((c) => c.id === GRP)?.recipients).toHaveLength(3);
    // um READY seguinte substitui (sessão nova)
    applyReady(qc, { guilds: guildsData(), private_channels: [dm("1900", [me, caio])] }, fx);
    expect(dmIds()).toEqual(["1900"]);
  });

  it("CHANNEL_CREATE de DM entra na lista (e não vira canal de servidor)", () => {
    send({ t: "CHANNEL_CREATE", d: dm("1300", [me, caio]) });
    expect(dmIds()).toContain("1300");
    expect(g1().channels?.some((c) => c.id === "1300")).toBe(false);
  });

  it("CHANNEL_UPDATE troca participantes e nome", () => {
    send({
      t: "CHANNEL_UPDATE",
      d: dm(GRP, [me, bia], { type: 4, owner_id: ME, name: "Novo nome" }),
    });
    const grp = dmsOf(qc).find((c) => c.id === GRP);
    expect(grp?.name).toBe("Novo nome");
    expect(grp?.recipients?.map((r) => r.id)).toEqual([ME, "50"]);
  });

  it("CHANNEL_DELETE de DM remove da lista, apaga o histórico e avisa se estava aberta", () => {
    qc.setQueryData<MessagePages>(queryKeys.messages(GRP), { pageParams: [undefined], pages: [] });
    where = { channelId: GRP };
    send({ t: "CHANNEL_DELETE", d: dm(GRP, [me, bia], { type: 4, name: "Estudo" }) });
    expect(dmIds()).toEqual([DM1]);
    expect(qc.getQueryData(queryKeys.messages(GRP))).toBeUndefined();
    expect(fx.dmGone).toHaveBeenCalledWith("Estudo");
  });

  it("CHANNEL_DELETE de DM que não está aberta não leva a lugar nenhum; eco de quem saiu é silencioso", () => {
    where = { guildId: "g1", channelId: CH };
    send({ t: "CHANNEL_DELETE", d: dm(GRP, [me, bia]) });
    expect(fx.dmGone).not.toHaveBeenCalled();
    where = { channelId: GRP };
    send({ t: "CHANNEL_DELETE", d: dm(GRP, [me, bia]) }); // já não está no cache
    expect(fx.dmGone).not.toHaveBeenCalled();
  });

  it("MESSAGE_CREATE em DM sobe a conversa na lista, conta como não lida e avisa", () => {
    where = { guildId: "g1", channelId: CH };
    send({ t: "MESSAGE_CREATE", d: dmMsg(GRP, "9000", "60") });
    expect(dmIds()[0]).toBe(GRP);
    const reads = useReadStateStore.getState().channels;
    expect(reads[GRP]?.unread).toBe(1);
    expect(reads[DM1]).toBeUndefined();
    expect(fx.notify).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: GRP, url: `/channels/@me/${GRP}`, body: "dm 9000" }),
    );
  });

  it("não conta nem avisa a minha própria mensagem; DM à vista não vira não lida, mas pede ack", () => {
    viewing = "caught-up";
    send({ t: "MESSAGE_CREATE", d: dmMsg(DM1, "9000", "50") });
    send({ t: "MESSAGE_CREATE", d: dmMsg(GRP, "9001", ME) });
    const reads = useReadStateStore.getState().channels;
    expect(reads[DM1]).toMatchObject({ unread: 0, latest: "9000" });
    expect(reads[GRP]).toBeUndefined();
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it("canal aberto mas rolado para cima conta como não lido, sem aviso", () => {
    viewing = "focused";
    send({ t: "MESSAGE_CREATE", d: dmMsg(DM1, "9000", "50") });
    expect(useReadStateStore.getState().channels[DM1]?.unread).toBe(1);
    expect(fx.notify).not.toHaveBeenCalled();
  });

  it("mensagem comum de servidor conta como não lida, mas não avisa; a menção direta avisa", () => {
    where = { guildId: "g1", channelId: "outro" };
    send({ t: "MESSAGE_CREATE", d: msg("2000") });
    expect(useReadStateStore.getState().channels[CH]).toMatchObject({ guildId: "g1", unread: 1 });
    expect(fx.notify).not.toHaveBeenCalled();
    send({ t: "MESSAGE_CREATE", d: { ...msg("2001", "oi @ana"), mention_ids: [ME] } });
    expect(useReadStateStore.getState().channels[CH]?.unread).toBe(2);
    expect(fx.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "bia (#geral · Alfa)", url: `/channels/g1/${CH}` }),
    );
  });

  it("silenciar notificações tira o aviso, mas a contagem segue", () => {
    useNotificationPrefs.getState().setMuted(true);
    send({ t: "MESSAGE_CREATE", d: dmMsg(GRP, "9000", "60") });
    expect(fx.notify).not.toHaveBeenCalled();
    expect(useReadStateStore.getState().channels[GRP]?.unread).toBe(1);
  });

  it("READY substitui as não lidas e READ_STATE_UPDATE atualiza as menções", () => {
    applyReady(
      qc,
      {
        guilds: [],
        read_states: [
          {
            channel_id: CH,
            guild_id: "g1",
            last_read_message_id: "1000",
            mention_count: 1,
            unread_count: 3,
          },
        ],
      },
      fx,
    );
    expect(useReadStateStore.getState().channels[CH]).toMatchObject({ unread: 3, mentions: 1 });
    send({
      t: "READ_STATE_UPDATE",
      d: { channel_id: CH, last_read_message_id: "1000", mention_count: 2 },
    });
    expect(useReadStateStore.getState().channels[CH]).toMatchObject({ unread: 3, mentions: 2 });
  });

  it("refreshAfterGap também invalida a lista de DMs", () => {
    refreshAfterGap(qc);
    expect(invalidated(queryKeys.dms())).toBe(true);
  });
});

describe("links para lugares que nunca foram do usuário", () => {
  it("READY com URL de servidor inexistente não avisa nem redireciona (a tela mostra 'não encontrado')", () => {
    where = { guildId: "nunca-fui", channelId: "x" };
    applyReady(qc, { guilds: guildsData() }, fx);
    expect(fx.leftGuild).not.toHaveBeenCalled();
    expect(fx.channelGone).not.toHaveBeenCalled();
  });

  it("READY com canal que nunca existiu no servidor também não avisa; canal que sumiu avisa", () => {
    where = { guildId: "g1", channelId: "nunca-existiu" };
    applyReady(qc, { guilds: guildsData() }, fx);
    expect(fx.channelGone).not.toHaveBeenCalled();
    where = { guildId: "g1", channelId: CH };
    const g = g1();
    applyReady(qc, { guilds: [{ ...g, channels: [] }] }, fx);
    expect(fx.channelGone).toHaveBeenCalledWith("g1", undefined);
  });
});

describe("presença", () => {
  it("READY semeia os status; PRESENCE_UPDATE atualiza e offline remove", () => {
    applyReady(qc, { guilds: [] }, fx);
    usePresenceStore.getState().replaceAll([{ user_id: "50", status: "online" }]);
    send({ t: "PRESENCE_UPDATE", d: { user_id: "50", status: "idle" } });
    expect(usePresenceStore.getState().statuses).toEqual({ "50": "idle" });
    send({ t: "PRESENCE_UPDATE", d: { user_id: "50", status: "offline" } });
    expect(usePresenceStore.getState().statuses).toEqual({});
  });
});

describe('"digitando…"', () => {
  const start = (user: string, channel = CH) =>
    send({
      t: "TYPING_START",
      d: { channel_id: channel, guild_id: "g1", user_id: user, timestamp: 1 },
    });

  it("TYPING_START de outra pessoa entra; o meu próprio evento é ignorado", () => {
    start("50");
    start(ME);
    expect(typing(CH)).toEqual(["50"]);
  });

  it("MESSAGE_CREATE do mesmo autor encerra o 'digitando…' dele (e só dele)", () => {
    start("50");
    start("60");
    send({ t: "MESSAGE_CREATE", d: msg("2000", "pronto", "50") });
    expect(typing(CH)).toEqual(["60"]);
  });

  it("refreshAfterGap zera os indicadores (o fim pode ter se perdido)", () => {
    start("50");
    refreshAfterGap(qc);
    expect(typing(CH)).toEqual([]);
  });
});

describe("USER_UPDATE (perfil de alguém mudou)", () => {
  const update = (over: Record<string, unknown> = {}) =>
    send({
      t: "USER_UPDATE",
      d: {
        id: "50",
        username: "bia",
        display_name: "Bia Nova",
        avatar_url: "https://s3.test/avatars/50/9.gif?sig=n",
        ...over,
      },
    });

  it("troca nome e avatar nos membros já carregados, sem refetch", () => {
    qc.setQueryData(queryKeys.members("g1"), {
      members: [
        {
          ...member("50", "bia"),
          guild_id: "g1",
          avatar_url: "https://s3.test/old.png",
          display_name: "Bia",
        },
        { ...member("51", "caio"), guild_id: "g1" },
      ],
    });
    update();
    const list = qc.getQueryData<{
      members: { user_id: string; display_name?: string; avatar_url?: string }[];
    }>(queryKeys.members("g1"));
    expect(list?.members[0]).toMatchObject({
      display_name: "Bia Nova",
      avatar_url: "https://s3.test/avatars/50/9.gif?sig=n",
    });
    expect(list?.members[1]?.display_name).not.toBe("Bia Nova");
    expect(invalidated(queryKeys.members("g1"))).toBe(false);
  });

  it("atualiza o autor das mensagens carregadas e o autor da citação", () => {
    const withReply = {
      ...msg("3000", "re", "51"),
      reply_to: {
        id: "1000",
        author: { id: "50", username: "bia" },
        content: "x",
        has_attachments: false,
        deleted: false,
      },
    };
    addMessage(qc, CH, msg("3001", "oi", "50"));
    addMessage(qc, CH, withReply);
    update();
    const h = history();
    expect(h.find((m) => m.id === "3001")?.author).toMatchObject({
      display_name: "Bia Nova",
      avatar_url: "https://s3.test/avatars/50/9.gif?sig=n",
    });
    expect(h.find((m) => m.id === "3000")?.reply_to?.author.display_name).toBe("Bia Nova");
    expect(h.find((m) => m.id === "3000")?.author.display_name).toBeUndefined();
  });

  it("atualiza os participantes das DMs", () => {
    qc.setQueryData(queryKeys.dms(), [dm("d1", [recipient("50", "bia"), recipient("51", "caio")])]);
    update();
    const r = dmsOf(qc)[0]?.recipients ?? [];
    expect(r.find((x) => x.id === "50")?.display_name).toBe("Bia Nova");
    expect(r.find((x) => x.id === "51")?.display_name).not.toBe("Bia Nova");
  });

  it("no próprio usuário, atualiza o `me`; no de outro, não mexe nele", () => {
    qc.setQueryData(queryKeys.me(), {
      ...({ id: ME, username: "ana", display_name: "Ana" } as object),
    });
    update();
    expect(qc.getQueryData<{ display_name?: string }>(queryKeys.me())?.display_name).toBe("Ana");
    update({ id: ME, username: "ana", display_name: "Ana Nova" });
    expect(qc.getQueryData<{ display_name?: string }>(queryKeys.me())?.display_name).toBe(
      "Ana Nova",
    );
  });

  it("sem cache carregado não faz nada (nem quebra)", () => {
    expect(() => update({ id: "999" })).not.toThrow();
  });
});
