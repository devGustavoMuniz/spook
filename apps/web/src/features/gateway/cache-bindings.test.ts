import type { DetailPayload, GatewayEvent, MessagePayload } from "@spook/shared";
import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addMessage, flattenPages, type MessagePages } from "@/lib/message-cache";
import { queryKeys } from "@/lib/queryKeys";
import { channel, guild, ME, member, messages, role } from "@/test/fixtures";
import { applyGatewayEvent, type GatewayEffects, refreshAfterGap } from "./cache-bindings";

const CH = "g1-txt";
let qc: QueryClient;
let fx: GatewayEffects & {
  leftGuild: ReturnType<typeof vi.fn>;
  channelGone: ReturnType<typeof vi.fn>;
};
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
  };
}

beforeEach(() => {
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  where = { guildId: "g1", channelId: CH };
  fx = {
    myId: () => ME,
    location: () => where,
    leftGuild: vi.fn(),
    channelGone: vi.fn(),
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
