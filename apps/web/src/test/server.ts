import type { ChannelPayload, DetailPayload, MemberPayload, MessagePayload } from "@spook/shared";
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
    requests: [] as { method: string; path: string; search: string; body?: unknown }[],
    nextId: 5000,
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
  ];
  return { state, handlers };

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
        const b = (await request.json()) as { content: string };
        track(request, b);
        if (state.rateLimited > 0) {
          state.rateLimited--;
          return HttpResponse.json(
            { title: "429", status: 429, detail: "limite de mensagens", errors: [] },
            { status: 429, headers: { "Retry-After": String(state.retryAfter) } },
          );
        }
        const cid = params.channelId as string;
        const msg: MessagePayload = {
          id: nextId(),
          channel_id: cid,
          author: { id: state.user.id, username: state.user.username },
          content: b.content.trim(),
          created_at: new Date().toISOString(),
          edited_at: null,
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
