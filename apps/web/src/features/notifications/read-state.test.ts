import { beforeEach, describe, expect, it } from "vitest";
import {
  allMentions,
  dmTotals,
  formatCount,
  guildTotals,
  UNREAD_CAP,
  useReadStateStore,
} from "./read-state";
import { compareIds } from "./snowflake";

const store = () => useReadStateStore.getState();
const ch = (id: string) => store().channels[id];
const rs = (channel_id: string, extra: Record<string, unknown> = {}) => ({
  channel_id,
  guild_id: "g1",
  last_read_message_id: "100",
  mention_count: 0,
  unread_count: 0,
  ...extra,
});

beforeEach(() => store().reset());

describe("snowflake", () => {
  it("compara ids numéricos em string (inclusive tamanhos diferentes)", () => {
    expect(compareIds("9", "10")).toBeLessThan(0);
    expect(compareIds("1000", "999")).toBeGreaterThan(0);
    expect(compareIds("1500000000000000001", "1500000000000000002")).toBeLessThan(0);
    expect(compareIds("5", "5")).toBe(0);
  });
});

describe("replaceAll (READY e GET)", () => {
  it("substitui tudo: canal ausente vale zero, e marca como carregado", () => {
    store().addUnread("velho", "g1", "5");
    expect(store().loaded).toBe(false);
    store().replaceAll([rs("a", { unread_count: 3, mention_count: 1 })]);
    expect(store().loaded).toBe(true);
    expect(ch("velho")).toBeUndefined();
    expect(ch("a")).toMatchObject({ guildId: "g1", lastRead: "100", unread: 3, mentions: 1 });
  });

  it("limita o unread em 100", () => {
    store().replaceAll([rs("a", { unread_count: 500 })]);
    expect(ch("a")?.unread).toBe(UNREAD_CAP);
  });
});

describe("addUnread (MESSAGE_CREATE fora de vista)", () => {
  it("incrementa a contagem e cria o canal que não estava no snapshot", () => {
    store().addUnread("a", "g1", "200");
    store().addUnread("a", "g1", "201");
    expect(ch("a")).toMatchObject({ unread: 2, mentions: 0, latest: "201" });
  });

  it("não passa de 100", () => {
    store().replaceAll([rs("a", { unread_count: 100 })]);
    store().addUnread("a", "g1", "200");
    expect(ch("a")?.unread).toBe(100);
  });

  it("ignora mensagem já coberta pelo ponto de leitura e evento repetido", () => {
    store().replaceAll([rs("a", { last_read_message_id: "150" })]);
    store().addUnread("a", "g1", "150");
    store().addUnread("a", "g1", "140");
    expect(ch("a")?.unread).toBe(0);
    store().addUnread("a", "g1", "160");
    store().addUnread("a", "g1", "160");
    expect(ch("a")?.unread).toBe(1);
  });

  it("não mexe nas menções (o servidor manda o valor absoluto)", () => {
    store().addUnread("a", "g1", "200");
    expect(ch("a")?.mentions).toBe(0);
  });
});

describe("READ_STATE_UPDATE", () => {
  it("define as menções absolutas e avança o ponto de leitura", () => {
    store().replaceAll([rs("a", { unread_count: 2, mention_count: 1 })]);
    const reconcile = store().applyUpdate({
      channel_id: "a",
      last_read_message_id: "100",
      mention_count: 3,
    });
    expect(reconcile).toBe(false);
    expect(ch("a")).toMatchObject({ mentions: 3, unread: 2, lastRead: "100" });
  });

  it("ack de outra sessão que alcança a mensagem mais nova que vi zera tudo", () => {
    store().replaceAll([rs("a", { unread_count: 1 })]);
    store().addUnread("a", "g1", "200");
    expect(
      store().applyUpdate({ channel_id: "a", last_read_message_id: "200", mention_count: 0 }),
    ).toBe(false);
    expect(ch("a")).toMatchObject({ unread: 0, mentions: 0, lastRead: "200" });
  });

  it("ack que avançou mas não sei se leu tudo pede o GET (reconciliar)", () => {
    store().replaceAll([rs("a", { unread_count: 5 })]);
    const reconcile = store().applyUpdate({
      channel_id: "a",
      last_read_message_id: "130",
      mention_count: 0,
    });
    expect(reconcile).toBe(true);
    expect(ch("a")?.lastRead).toBe("130");
    expect(ch("a")?.unread).toBe(5); // até o GET chegar
  });

  it("nunca regride o ponto de leitura", () => {
    store().replaceAll([rs("a", { last_read_message_id: "150" })]);
    store().applyUpdate({ channel_id: "a", last_read_message_id: "120", mention_count: 0 });
    expect(ch("a")?.lastRead).toBe("150");
  });

  it("canal desconhecido com menção entra; sem menção é ignorado", () => {
    store().applyUpdate({ channel_id: "x", last_read_message_id: "9", mention_count: 0 });
    expect(ch("x")).toBeUndefined();
    store().applyUpdate({ channel_id: "x", last_read_message_id: "9", mention_count: 2 });
    expect(ch("x")).toMatchObject({ mentions: 2, unread: 1 });
  });
});

describe("markRead (ack deste cliente)", () => {
  it("zera as não lidas e usa as menções que o servidor devolveu", () => {
    store().replaceAll([rs("a", { unread_count: 4, mention_count: 2 })]);
    store().markRead("a", "300", 0);
    expect(ch("a")).toMatchObject({ unread: 0, mentions: 0, lastRead: "300" });
    store().addUnread("a", "g1", "310");
    store().markRead("a", "305", 1); // menção que chegou no meio do caminho
    expect(ch("a")).toMatchObject({ unread: 0, mentions: 1, lastRead: "305" });
  });

  it("não regride o ponto de leitura", () => {
    store().replaceAll([rs("a", { last_read_message_id: "500", unread_count: 1 })]);
    store().markRead("a", "400");
    expect(ch("a")?.lastRead).toBe("500");
  });
});

describe("noteSeen, removeChannel e removeGuild", () => {
  it("noteSeen não conta como não lida, mas guarda a mais nova vista", () => {
    store().noteSeen("a", "g1", "200");
    expect(ch("a")).toMatchObject({ unread: 0, latest: "200" });
  });
  it("removeChannel e removeGuild limpam", () => {
    store().replaceAll([rs("a"), rs("b"), rs("d", { guild_id: undefined })]);
    store().removeChannel("a");
    expect(ch("a")).toBeUndefined();
    store().removeGuild("g1");
    expect(Object.keys(store().channels)).toEqual(["d"]);
  });
});

describe("derivados", () => {
  const channels = {
    a: { guildId: "g1", lastRead: "1", unread: 60, mentions: 1 },
    b: { guildId: "g1", lastRead: "1", unread: 70, mentions: 2 },
    c: { guildId: "g2", lastRead: "1", unread: 1, mentions: 0 },
    d: { lastRead: "1", unread: 3, mentions: 3 },
    e: { lastRead: "1", unread: 0, mentions: 0 },
  } as const;

  it("soma por servidor limitando as não lidas em 100 (menções somam direto)", () => {
    expect(guildTotals(channels, "g1")).toEqual({ unread: 100, mentions: 3 });
    expect(guildTotals(channels, "g2")).toEqual({ unread: 1, mentions: 0 });
    expect(guildTotals(channels, "g3")).toEqual({ unread: 0, mentions: 0 });
  });

  it("DMs ficam fora dos servidores e contam conversas com novidade", () => {
    expect(dmTotals(channels)).toEqual({ unread: 3, mentions: 3, conversations: 1 });
  });

  it("total de menções (título da aba)", () => {
    expect(allMentions(channels)).toBe(6);
  });

  it("formatCount: 99+ acima de 99", () => {
    expect([0, 5, 99, 100, 250].map(formatCount)).toEqual(["0", "5", "99", "99+", "99+"]);
  });
});
