import type {
  ChannelPayload,
  DetailPayload,
  MemberPayload,
  MessagePayload,
  ReadStatePayload,
} from "@spook/shared";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { guild as makeGuild, member, role } from "./fixtures";

export type FakeUser = {
  id: string;
  email: string;
  username: string;
  display_name?: string;
  avatar_url?: string;
  created_at: string;
};

export const sampleUser: FakeUser = {
  id: "1",
  email: "ana@spook.dev",
  username: "ana",
  created_at: "2026-10-30T12:00:00Z",
};

const problem = (status: number, detail: string, errors: unknown[] = []) =>
  HttpResponse.json({ title: String(status), status, detail, errors }, { status });

/** Backend falso em memória: o cookie vira uma flag `signedIn`. */
export function makeBackend(initial: { signedIn?: boolean } = {}) {
  const state = {
    signedIn: initial.signedIn ?? false,
    user: { ...sampleUser },
    patches: [] as unknown[],
    logouts: 0,
    // Servidores (fonte de verdade da lista), membros e mensagens por canal (ordem crescente).
    guilds: [] as DetailPayload[],
    /** Canais para os quais o usuário avisou "digitando…" (`POST /channels/{id}/typing`). */
    typing: [] as string[],
    /** DMs do usuário (fonte de verdade de `GET /users/@me/channels`). */
    dms: [] as ChannelPayload[],
    /** Resposta forçada de `POST /users/@me/channels` (simula 403/409/422/429). */
    openDmError: null as null | { status: number; detail: string; retryAfter?: number },
    members: {} as Record<string, MemberPayload[]>,
    messages: {} as Record<string, MessagePayload[]>,
    /** Convites: código → resposta do preview; `gone` simula 410, ausente simula 404. */
    invites: {} as Record<
      string,
      { guild: DetailPayload; gone?: boolean; preview?: Record<string, unknown> }
    >,
    /** Quantos envios seguintes devolvem 429 (com Retry-After). */
    rateLimited: 0,
    retryAfter: 1,
    /** Atraso (ms) da resposta do POST de mensagens, para testar o que acontece enquanto o envio está pendente. */
    sendDelayMs: 0,
    /** Fixadas por canal (ids, a mais recentemente fixada primeiro); `pinError` força o status de PUT/DELETE em /pins. */
    pins: {} as Record<string, string[]>,
    pinError: null as null | { status: number; detail: string },
    /** Se definido, o POST de mensagens falha com este status. */
    sendError: null as null | { status: number; detail: string },
    requests: [] as { method: string; path: string; search: string; body?: unknown }[],
    nextId: 5000,
    /** Não lidas (Fase 6): resposta do GET e os acks recebidos (`PUT /channels/{id}/ack`). */
    readStates: [] as ReadStatePayload[],
    acks: [] as { channelId: string; messageId: string }[],
    /** Status e silêncio/nível (adicional): preferência atual, PATCHs recebidos e configurações por alvo. */
    presence: { status_pref: "online", custom_status: undefined } as Record<string, unknown>,
    presencePatches: [] as Record<string, unknown>[],
    notifSettings: [] as Record<string, unknown>[],
    /** Push (Fase 6): chave pública (`null` = 503, desligado) e as inscrições/remoções recebidas. */
    push: {
      publicKey:
        "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" as
          | string
          | null,
      subscribed: [] as { endpoint: string; keys: { p256dh: string; auth: string } }[],
      unsubscribed: [] as string[],
      subscribeStatus: 204,
    },
    /** Uploads (Fase 6): pedidos recebidos e erro forçado. */
    uploads: {
      requested: [] as {
        channelId: string;
        filename: string;
        content_type: string;
        size: number;
      }[],
      error: null as null | { status: number; detail: string },
    },
    /** Voz (Fase 5): erro forçado do token, tokens emitidos e PATCH /voice/state / leave recebidos. */
    voice: {
      tokenError: null as null | { status: number; detail: string },
      tokensFor: [] as string[],
      stateBodies: [] as { self_mute: boolean; self_deaf: boolean }[],
      stateStatus: 200,
      leaves: 0,
    },
  };
  const nextId = () => String(state.nextId++);
  const track = (request: Request, body?: unknown) => {
    const u = new URL(request.url);
    state.requests.push({ method: request.method, path: u.pathname, search: u.search, body });
  };

  const handlers = [
    http.get("*/api/users/me", () =>
      state.signedIn ? HttpResponse.json(state.user) : problem(401, "autenticação necessária"),
    ),
    http.post("*/api/auth/login", async ({ request }) => {
      const b = (await request.json()) as { email: string; password: string };
      if (b.password !== "senha-correta-1") return problem(401, "e-mail ou senha incorretos");
      state.signedIn = true;
      return HttpResponse.json({ user: state.user });
    }),
    http.post("*/api/auth/register", async ({ request }) => {
      const b = (await request.json()) as { email: string; username: string };
      if (b.email === sampleUser.email) return problem(409, "e-mail já cadastrado");
      if (b.username === "ocupado") return problem(409, "nome de usuário já em uso");
      state.signedIn = true;
      state.user = { ...sampleUser, email: b.email, username: b.username };
      return HttpResponse.json({ user: state.user }, { status: 201 });
    }),
    // Desktop: o gateway pede um ticket antes do WebSocket (o socket em si é falso nos testes).
    http.post("*/api/gateway/ticket", () =>
      HttpResponse.json({ ticket: "ticket-teste", expires_in: 30 }),
    ),
    http.post("*/api/auth/logout", () => {
      state.logouts++;
      state.signedIn = false;
      return new HttpResponse(null, { status: 204 });
    }),
    http.patch("*/api/users/me", async ({ request }) => {
      const b = (await request.json()) as { display_name?: string };
      state.patches.push(b);
      if (b.display_name !== undefined)
        state.user = { ...state.user, display_name: b.display_name || undefined };
      return HttpResponse.json(state.user);
    }),
    ...guildHandlers(),
    ...dmHandlers(),
    ...voiceHandlers(),
    ...notificationHandlers(),
  ];
  return { state, handlers };

  function notificationHandlers() {
    return [
      http.get("*/api/users/@me/read-states", ({ request }) => {
        track(request);
        const guilds = new Map<string, { unread: number; mentions: number }>();
        for (const r of state.readStates) {
          if (!r.guild_id) continue;
          const g = guilds.get(r.guild_id) ?? { unread: 0, mentions: 0 };
          g.unread = Math.min(100, g.unread + r.unread_count);
          g.mentions += r.mention_count;
          guilds.set(r.guild_id, g);
        }
        return HttpResponse.json({
          read_states: state.readStates,
          guilds: [...guilds].map(([guild_id, g]) => ({
            guild_id,
            unread_count: g.unread,
            mention_count: g.mentions,
          })),
        });
      }),
      http.put("*/api/channels/:channelId/ack", async ({ params, request }) => {
        const b = (await request.json()) as { message_id: string };
        track(request, b);
        const channelId = params.channelId as string;
        state.acks.push({ channelId, messageId: b.message_id });
        return HttpResponse.json({
          channel_id: channelId,
          last_read_message_id: b.message_id,
          mention_count: 0,
        });
      }),
      http.get("*/api/users/@me/presence", () => HttpResponse.json(state.presence)),
      http.patch("*/api/users/@me/presence", async ({ request }) => {
        const b = (await request.json()) as Record<string, unknown>;
        track(request, b);
        state.presencePatches.push(b);
        if (b.status_pref === "away") return problem(422, "preferência de status inválida");
        if (typeof b.status_pref === "string") state.presence.status_pref = b.status_pref;
        if (b.clear_custom_status) state.presence.custom_status = undefined;
        else if (b.custom_status) state.presence.custom_status = b.custom_status;
        return HttpResponse.json(state.presence);
      }),
      http.get("*/api/users/@me/notification-settings", ({ request }) => {
        track(request);
        return HttpResponse.json({ settings: state.notifSettings });
      }),
      http.put(
        "*/api/users/@me/notification-settings/:scope/:targetId",
        async ({ params, request }) => {
          const b = (await request.json()) as Record<string, unknown>;
          track(request, b);
          const row = {
            scope: params.scope,
            target_id: params.targetId,
            muted: !!b.muted,
            muted_until: b.muted_until ?? null,
            level: b.level ?? null,
          };
          state.notifSettings = [
            ...state.notifSettings.filter(
              (r) => !(r.scope === row.scope && r.target_id === row.target_id),
            ),
            row,
          ];
          return HttpResponse.json(row);
        },
      ),
      http.delete(
        "*/api/users/@me/notification-settings/:scope/:targetId",
        ({ params, request }) => {
          track(request);
          state.notifSettings = state.notifSettings.filter(
            (r) => !(r.scope === params.scope && r.target_id === params.targetId),
          );
          return new HttpResponse(null, { status: 204 });
        },
      ),
      http.get("*/api/push/vapid-public-key", () =>
        state.push.publicKey
          ? HttpResponse.json({ public_key: state.push.publicKey })
          : problem(503, "notificações push desligadas"),
      ),
      http.post("*/api/push/subscriptions", async ({ request }) => {
        const b = (await request.json()) as {
          endpoint: string;
          keys: { p256dh: string; auth: string };
        };
        track(request, b);
        if (state.push.subscribeStatus !== 204)
          return problem(state.push.subscribeStatus, "não foi possível inscrever");
        state.push.subscribed.push(b);
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("*/api/push/subscriptions", async ({ request }) => {
        const b = (await request.json()) as { endpoint: string };
        track(request, b);
        state.push.unsubscribed.push(b.endpoint);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("*/api/channels/:channelId/uploads", async ({ params, request }) => {
        const b = (await request.json()) as {
          filename: string;
          content_type: string;
          size: number;
        };
        track(request, b);
        const e = state.uploads.error;
        if (e) return problem(e.status, e.detail);
        state.uploads.requested.push({ channelId: params.channelId as string, ...b });
        const id = nextId();
        return HttpResponse.json(
          {
            id,
            upload_url: `https://storage.test/upload/${id}`,
            headers: { "Content-Type": b.content_type },
            expires_in: 300,
          },
          { status: 201 },
        );
      }),
    ];
  }

  function voiceHandlers() {
    return [
      http.post("*/api/channels/:channelId/voice/token", ({ params }) => {
        const e = state.voice.tokenError;
        if (e) return problem(e.status, e.detail);
        state.voice.tokensFor.push(params.channelId as string);
        return HttpResponse.json({
          url: "ws://livekit.test:7880",
          token: `token-${params.channelId}-${state.voice.tokensFor.length}`,
          expires_in: 600,
        });
      }),
      http.patch("*/api/voice/state", async ({ request }) => {
        const b = (await request.json()) as { self_mute: boolean; self_deaf: boolean };
        state.voice.stateBodies.push(b);
        if (state.voice.stateStatus !== 200)
          return problem(state.voice.stateStatus, "você não está em um canal de voz");
        return HttpResponse.json({
          ...b,
          user_id: state.user.id,
          channel_id: null,
          guild_id: null,
          self_video: false,
          self_screen: false,
        });
      }),
      http.post("*/api/voice/leave", () => {
        state.voice.leaves++;
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }

  function dmHandlers() {
    const fail = (e: NonNullable<typeof state.openDmError>) =>
      HttpResponse.json(
        { title: String(e.status), status: e.status, detail: e.detail, errors: [] },
        {
          status: e.status,
          headers: e.retryAfter ? { "Retry-After": String(e.retryAfter) } : undefined,
        },
      );
    const find = (id: unknown) => state.dms.find((c) => c.id === id);
    return [
      http.get("*/api/users/@me/channels", ({ request }) => {
        track(request);
        return HttpResponse.json(state.dms);
      }),
      http.post("*/api/users/@me/channels", async ({ request }) => {
        const b = (await request.json()) as { recipient_id?: string; recipient_ids?: string[] };
        track(request, b);
        if (state.openDmError) return fail(state.openDmError);
        const me = { id: state.user.id, username: state.user.username };
        const lookup = (id: string) => {
          for (const list of Object.values(state.members)) {
            const m = list.find((x) => x.user_id === id);
            if (m) return { id, username: m.username };
          }
          return { id, username: `user${id}` };
        };
        if (b.recipient_id) {
          const existing = state.dms.find(
            (c) => c.type === 3 && c.recipients?.some((r) => r.id === b.recipient_id),
          );
          if (existing) return HttpResponse.json(existing, { status: 200 });
          const ch: ChannelPayload = {
            id: nextId(),
            type: 3,
            guild_id: null,
            parent_id: null,
            name: "",
            position: 0,
            last_message_id: null,
            created_at: new Date().toISOString(),
            recipients: [me, lookup(b.recipient_id)],
          };
          state.dms.push(ch);
          return HttpResponse.json(ch, { status: 201 });
        }
        const ch: ChannelPayload = {
          id: nextId(),
          type: 4,
          guild_id: null,
          parent_id: null,
          name: "",
          position: 0,
          last_message_id: null,
          created_at: new Date().toISOString(),
          owner_id: state.user.id,
          recipients: [me, ...(b.recipient_ids ?? []).map(lookup)],
        };
        state.dms.push(ch);
        return HttpResponse.json(ch, { status: 201 });
      }),
      http.patch("*/api/channels/:channelId", async ({ params, request }) => {
        const b = (await request.json()) as { name?: string };
        track(request, b);
        const ch = find(params.channelId);
        if (!ch) return problem(404, "canal não encontrado");
        ch.name = b.name ?? ch.name;
        return HttpResponse.json(ch);
      }),
      http.put("*/api/channels/:channelId/recipients/:userId", ({ params, request }) => {
        track(request);
        const ch = find(params.channelId);
        if (!ch) return problem(404, "canal não encontrado");
        const id = params.userId as string;
        if (!ch.recipients?.some((r) => r.id === id))
          ch.recipients = [...(ch.recipients ?? []), { id, username: `user${id}` }];
        return HttpResponse.json(ch);
      }),
      http.delete("*/api/channels/:channelId/recipients/:userId", ({ params, request }) => {
        track(request);
        const ch = find(params.channelId);
        if (!ch) return problem(404, "canal não encontrado");
        const id = params.userId === "@me" ? state.user.id : (params.userId as string);
        if (id === ch.owner_id) return problem(409, "o dono não pode sair da conversa");
        ch.recipients = (ch.recipients ?? []).filter((r) => r.id !== id);
        if (id === state.user.id) state.dms = state.dms.filter((c) => c.id !== ch.id);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post("*/api/channels/:channelId/typing", ({ params }) => {
        state.typing.push(params.channelId as string);
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }

  function guildHandlers() {
    return [
      http.get("*/api/guilds", ({ request }) => {
        track(request);
        return HttpResponse.json(state.guilds);
      }),
      http.post("*/api/guilds", async ({ request }) => {
        const b = (await request.json()) as { name: string };
        track(request, b);
        const id = nextId();
        const g = makeGuild(id, b.name, {
          owner_id: state.user.id,
          is_owner: true,
          permissions: 8191,
          roles: [role(id, "@everyone", 0, { is_everyone: true, permissions: 0 })],
        });
        state.members[id] = [member(state.user.id, state.user.username)];
        state.guilds.push(g);
        return HttpResponse.json(g, { status: 201 });
      }),
      http.get("*/api/guilds/:guildId/members", ({ params }) =>
        HttpResponse.json({
          members: state.members[params.guildId as string] ?? [],
          has_more: false,
        }),
      ),
      http.patch("*/api/guilds/:guildId/channels/positions", async ({ request, params }) => {
        const b = (await request.json()) as {
          channels: { id: string; position: number; parent_id: string | null }[];
        };
        track(request, b);
        const g = state.guilds.find((x) => x.id === params.guildId);
        if (g) {
          g.channels = (g.channels ?? [])
            .map((c) => {
              const p = b.channels.find((x) => x.id === c.id);
              return p ? { ...c, position: p.position, parent_id: p.parent_id } : c;
            })
            .sort((a, z) => a.position - z.position);
        }
        return HttpResponse.json(g?.channels ?? []);
      }),
      http.get("*/api/guilds/:guildId/invites", () => HttpResponse.json([])),
      http.post("*/api/guilds/:guildId/invites", async ({ request, params }) => {
        const b = await request.json();
        track(request, b);
        return HttpResponse.json(
          {
            code: "abcd2345",
            guild_id: params.guildId,
            creator_id: state.user.id,
            uses: 0,
            max_uses: (b as { max_uses?: number }).max_uses ?? null,
            expires_at: null,
            created_at: "2026-10-30T12:00:00Z",
          },
          { status: 201 },
        );
      }),
      http.get("*/api/invites/:code", ({ params }) => {
        const inv = state.invites[params.code as string];
        if (!inv) return problem(404, "convite não encontrado");
        if (inv.gone) return problem(410, "convite expirado");
        return HttpResponse.json({
          code: params.code,
          guild_id: inv.guild.id,
          guild_name: inv.guild.name,
          member_count: 3,
          uses: 0,
          max_uses: null,
          expires_at: null,
          ...inv.preview,
        });
      }),
      http.post("*/api/invites/:code", ({ params, request }) => {
        track(request);
        const inv = state.invites[params.code as string];
        if (!inv) return problem(404, "convite não encontrado");
        if (inv.gone) return problem(410, "convite expirado");
        if (!state.guilds.some((g) => g.id === inv.guild.id)) state.guilds.push(inv.guild);
        return HttpResponse.json(inv.guild);
      }),
      http.get("*/api/channels/:channelId/messages", ({ params, request }) => {
        track(request);
        const url = new URL(request.url);
        const before = url.searchParams.get("before");
        const limit = Number(url.searchParams.get("limit") ?? 50);
        const all = state.messages[params.channelId as string] ?? [];
        const older = (before ? all.filter((m) => BigInt(m.id) < BigInt(before)) : all)
          .slice()
          .reverse();
        return HttpResponse.json({
          messages: older.slice(0, limit),
          has_more: older.length > limit,
        });
      }),
      http.post("*/api/channels/:channelId/messages", async ({ params, request }) => {
        const b = (await request.json()) as {
          content: string;
          attachment_ids?: string[] | null;
          reply_to?: string;
          mention_reply?: boolean;
        };
        track(request, b);
        if (state.sendDelayMs > 0) await new Promise((r) => setTimeout(r, state.sendDelayMs));
        if (state.sendError) {
          return HttpResponse.json(
            {
              title: "erro",
              status: state.sendError.status,
              detail: state.sendError.detail,
              errors: [],
            },
            { status: state.sendError.status },
          );
        }
        if (state.rateLimited > 0) {
          state.rateLimited--;
          return HttpResponse.json(
            { title: "429", status: 429, detail: "limite de mensagens", errors: [] },
            { status: 429, headers: { "Retry-After": String(state.retryAfter) } },
          );
        }
        const cid = params.channelId as string;
        // Responder: a original precisa existir no canal (senão 422, como o servidor).
        let replyTo: MessagePayload["reply_to"] = null;
        let mentionIds: string[] = [];
        if (b.reply_to) {
          const orig = (state.messages[cid] ?? []).find((m) => m.id === b.reply_to);
          if (!orig) {
            return problem(
              422,
              "a mensagem respondida não existe mais, foi apagada ou é de outro canal",
            );
          }
          replyTo = {
            id: orig.id,
            author: orig.author,
            content: Array.from(orig.content).slice(0, 100).join(""),
            has_attachments: orig.attachments.length > 0,
            deleted: false,
          };
          if (b.mention_reply !== false && orig.author.id !== state.user.id)
            mentionIds = [orig.author.id];
        }
        const msg: MessagePayload = {
          id: nextId(),
          channel_id: cid,
          author: { id: state.user.id, username: state.user.username },
          content: (b.content ?? "").trim(),
          created_at: new Date().toISOString(),
          edited_at: null,
          attachments: (b.attachment_ids ?? []).map((id) => ({
            id,
            filename: `arquivo-${id}.txt`,
            content_type: "text/plain",
            size: 12,
            url: `https://storage.test/get/${id}`,
          })),
          mention_ids: mentionIds,
          reply_to: replyTo,
          pinned: false,
        };
        state.messages[cid] = [...(state.messages[cid] ?? []), msg];
        return HttpResponse.json(msg, { status: 201 });
      }),
      http.patch("*/api/channels/:channelId/messages/:messageId", async ({ params, request }) => {
        const b = (await request.json()) as { content: string };
        track(request, b);
        const list = state.messages[params.channelId as string] ?? [];
        const i = list.findIndex((m) => m.id === params.messageId);
        const cur = list[i];
        if (!cur) return problem(404, "mensagem não encontrada");
        const next = { ...cur, content: b.content, edited_at: new Date().toISOString() };
        list[i] = next;
        return HttpResponse.json(next);
      }),
      http.get("*/api/channels/:channelId/pins", ({ params, request }) => {
        track(request);
        const cid = params.channelId as string;
        const all = state.messages[cid] ?? [];
        const ids = state.pins[cid] ?? [];
        return HttpResponse.json({
          messages: ids.flatMap((id) => all.filter((m) => m.id === id && m.pinned)),
        });
      }),
      http.put("*/api/channels/:channelId/pins/:messageId", ({ params, request }) => {
        track(request);
        if (state.pinError) return problem(state.pinError.status, state.pinError.detail);
        const cid = params.channelId as string;
        const list = state.messages[cid] ?? [];
        const i = list.findIndex((m) => m.id === params.messageId);
        const cur = list[i];
        if (!cur) return problem(404, "mensagem não encontrada");
        list[i] = { ...cur, pinned: true };
        state.pins[cid] = [cur.id, ...(state.pins[cid] ?? []).filter((id) => id !== cur.id)];
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("*/api/channels/:channelId/pins/:messageId", ({ params, request }) => {
        track(request);
        if (state.pinError) return problem(state.pinError.status, state.pinError.detail);
        const cid = params.channelId as string;
        const list = state.messages[cid] ?? [];
        const i = list.findIndex((m) => m.id === params.messageId);
        const cur = list[i];
        if (!cur) return problem(404, "mensagem não encontrada");
        list[i] = { ...cur, pinned: false };
        state.pins[cid] = (state.pins[cid] ?? []).filter((id) => id !== cur.id);
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("*/api/channels/:channelId/messages/:messageId", ({ params, request }) => {
        track(request);
        const cid = params.channelId as string;
        state.messages[cid] = (state.messages[cid] ?? []).filter((m) => m.id !== params.messageId);
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }
}

export type Backend = ReturnType<typeof makeBackend>;

export const server = setupServer();
