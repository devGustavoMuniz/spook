import { describe, expect, it, vi } from "vitest";
import { channelUrl, previewBody, safeAppPath, shouldNotify } from "./in-app";
import { type NotifyDeps, showInAppNotification } from "./notify";
import { shouldAck } from "./use-auto-ack";
import { pageActive, viewingOf } from "./viewport";

describe("shouldNotify", () => {
  const base = {
    authorId: "50",
    myId: "1",
    isDm: false,
    mentionIds: [] as string[],
    viewing: "away" as const,
    muted: false,
  };
  it("DM avisa; mensagem comum de servidor não; menção direta avisa", () => {
    expect(shouldNotify({ ...base, isDm: true })).toBe(true);
    expect(shouldNotify(base)).toBe(false);
    expect(shouldNotify({ ...base, mentionIds: ["1"] })).toBe(true);
    expect(shouldNotify({ ...base, mentionIds: ["2"] })).toBe(false);
  });
  it("nunca a minha mensagem, nem silenciado, nem com o canal à vista", () => {
    expect(shouldNotify({ ...base, isDm: true, authorId: "1" })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, muted: true })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, viewing: "caught-up" })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, viewing: "focused" })).toBe(false);
    expect(shouldNotify({ ...base, isDm: true, myId: null })).toBe(false);
  });
});

describe("texto e links", () => {
  it("previewBody colapsa espaços, corta em 120 e descreve anexos", () => {
    expect(previewBody({ content: "  oi \n  mundo ", attachments: [] })).toBe("oi mundo");
    expect(previewBody({ content: "a".repeat(130), attachments: [] })).toBe(`${"a".repeat(120)}…`);
    const att = (filename: string) => ({
      id: "1",
      filename,
      content_type: "image/png",
      size: 1,
      url: "u",
    });
    expect(previewBody({ content: "", attachments: [att("foto.png")] })).toBe("📎 foto.png");
    expect(previewBody({ content: "", attachments: [att("a"), att("b")] })).toBe("📎 2 arquivos");
  });
  it("channelUrl e safeAppPath", () => {
    expect(channelUrl("12", "34")).toBe("/channels/12/34");
    expect(channelUrl(undefined, "34")).toBe("/channels/@me/34");
    expect(safeAppPath("/channels/12/34")).toBe("/channels/12/34");
    expect(safeAppPath("/channels/@me/34")).toBe("/channels/@me/34");
    for (const bad of [
      "https://evil.test/channels/1/2",
      "//evil.test",
      "/login",
      "/channels/1",
      5,
      null,
    ])
      expect(safeAppPath(bad)).toBeNull();
  });
});

describe("viewingOf / pageActive", () => {
  it("canal aberto + aba ativa: no fim = lido na hora; rolado = à vista", () => {
    expect(viewingOf("a", { channelId: "a", atBottom: true }, true)).toBe("caught-up");
    expect(viewingOf("a", { channelId: "a", atBottom: false }, true)).toBe("focused");
  });
  it("outro canal ou aba inativa = longe", () => {
    expect(viewingOf("a", { channelId: "b", atBottom: true }, true)).toBe("away");
    expect(viewingOf("a", { channelId: "a", atBottom: true }, false)).toBe("away");
  });
  it("pageActive exige visível e com foco", () => {
    expect(pageActive({ visibilityState: "visible", hasFocus: () => true })).toBe(true);
    expect(pageActive({ visibilityState: "hidden", hasFocus: () => true })).toBe(false);
    expect(pageActive({ visibilityState: "visible", hasFocus: () => false })).toBe(false);
  });
});

describe("shouldAck (quando acusar leitura)", () => {
  const ok = {
    enabled: true,
    active: true,
    atBottom: true,
    lastMessageId: "200",
    read: { unread: 2, mentions: 0, lastRead: "100", latest: undefined as string | undefined },
    alreadyAcked: undefined as string | undefined,
  };
  it("acusa com canal aberto, aba ativa, no fim e algo a limpar", () => {
    expect(shouldAck(ok)).toBe(true);
    expect(shouldAck({ ...ok, read: { ...ok.read, unread: 0, mentions: 1 } })).toBe(true);
  });
  it("acusa mensagem vista ao vivo que o servidor ainda não sabe que foi lida", () => {
    expect(
      shouldAck({ ...ok, read: { unread: 0, mentions: 0, lastRead: "100", latest: "200" } }),
    ).toBe(true);
  });
  it.each([
    ["desligado", { enabled: false }],
    ["aba inativa", { active: false }],
    ["rolado para cima", { atBottom: false }],
    ["sem mensagens", { lastMessageId: undefined }],
    ["sem estado de leitura", { read: undefined }],
    ["nada a limpar", { read: { unread: 0, mentions: 0, lastRead: "200", latest: "200" } }],
    ["id já acusado", { alreadyAcked: "200" }],
    ["id mais velho já acusado", { alreadyAcked: "250" }],
  ])("não acusa: %s", (_n, patch) => {
    expect(shouldAck({ ...ok, ...patch })).toBe(false);
  });
  it("acusa de novo se chegou mensagem mais nova que o último ack", () => {
    expect(shouldAck({ ...ok, alreadyAcked: "150" })).toBe(true);
  });
});

describe("showInAppNotification", () => {
  const n = { channelId: "c1", title: "bia", body: "oi", url: "/channels/@me/c1", mention: false };
  function deps(over: Partial<NotifyDeps> = {}) {
    const created: {
      title: string;
      opts: NotificationOptions;
      onclick: null | (() => void);
      close: () => void;
    }[] = [];
    const d: NotifyDeps = {
      hidden: () => false,
      permission: () => "default",
      createNotification: (title, opts) => {
        const note = { title, opts, onclick: null as null | (() => void), close: vi.fn() };
        created.push(note);
        return note as never;
      },
      focusWindow: vi.fn(),
      toast: vi.fn(),
      ...over,
    };
    return { d, created };
  }

  it("aba visível: toast; o clique leva ao canal", () => {
    const { d, created } = deps();
    const open = vi.fn();
    showInAppNotification(n, open, d);
    expect(created).toHaveLength(0);
    const [notif, go] = (d.toast as ReturnType<typeof vi.fn>).mock.calls[0] as [
      typeof n,
      () => void,
    ];
    expect(notif.title).toBe("bia");
    go();
    expect(open).toHaveBeenCalledWith("/channels/@me/c1");
  });

  it("aba oculta com permissão: notificação do navegador por canal (tag), com ícone e clique", () => {
    const { d, created } = deps({ hidden: () => true, permission: () => "granted" });
    const open = vi.fn();
    showInAppNotification(n, open, d);
    expect(d.toast).not.toHaveBeenCalled();
    expect(created[0]).toMatchObject({
      title: "bia",
      opts: { body: "oi", tag: "c1", icon: "/icon-192.png" },
    });
    created[0]?.onclick?.();
    expect(d.focusWindow).toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("/channels/@me/c1");
    expect(created[0]?.close).toHaveBeenCalled();
  });

  it("aba oculta sem permissão, ou construtor que falha: cai para o toast", () => {
    const a = deps({ hidden: () => true, permission: () => "denied" });
    showInAppNotification(n, vi.fn(), a.d);
    expect(a.d.toast).toHaveBeenCalled();
    const b = deps({
      hidden: () => true,
      permission: () => "granted",
      createNotification: () => {
        throw new TypeError("Illegal constructor");
      },
    });
    showInAppNotification(n, vi.fn(), b.d);
    expect(b.d.toast).toHaveBeenCalled();
  });
});
