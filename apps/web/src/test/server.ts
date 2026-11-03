import type {
  AuditEntryPayload,
  BanPayload,
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
  bio?: string;
  pronouns?: string;
  banner_url?: string;
  banner_color?: number;
  is_admin?: boolean;
  email_verified?: boolean;
  pending_email?: string;
  has_password?: boolean;
  created_at: string;
};

export const sampleUser: FakeUser = {
  id: "1",
  email: "ana@spook.dev",
  username: "ana",
  email_verified: true,
  has_password: true,
  created_at: "2026-10-30T12:00:00Z",
};

const problem = (
  status: number,
  detail: string,
  errors: unknown[] = [],
  extra: Record<string, unknown> = {},
) => HttpResponse.json({ title: String(status), status, detail, errors, ...extra }, { status });

/** Backend falso em memória: o cookie vira uma flag `signedIn`. */
export function makeBackend(initial: { signedIn?: boolean } = {}) {
  const state = {
    signedIn: initial.signedIn ?? false,
    user: { ...sampleUser },
    patches: [] as unknown[],
    logouts: 0,
    /** Conta (senha, e-mail, exclusão): a senha correta é "senha-correta-1"; `confirmed` imita o "modo sudo". */
    account: {
      confirmed: false,
      passwordChanges: [] as { current_password: string; new_password: string }[],
      emailChanges: [] as string[],
      deletes: [] as string[],
      ownedGuilds: [] as { id: string; name: string }[],
      bannerUploads: [] as { content_type: string; size: number }[],
    },
    /** E-mail e login social (adicional): o que o servidor falso responde e o que recebeu. */
    auth: {
      providers: [] as string[],
      emailEnabled: false,
      /** token do link -> resultado de `POST /auth/email/verify` e `/auth/password/reset`. */
      tokens: {} as Record<string, "verified" | "changed" | "expired" | "invalid">,
      verifies: [] as string[],
      resends: 0,
      resendStatus: 204,
      forgots: [] as string[],
      forgotStatus: 202,
      resets: [] as { token: string; new_password: string }[],
      /** Cadastro social em andamento (`null` = expirado, 410). */
      pending: null as null | { provider: string; email: string; suggested_username: string },
      completes: [] as string[],
      methods: {
        has_password: true,
        accounts: [] as { provider: string; email?: string; created_at: string }[],
      },
      unlinks: [] as string[],
      unlinkStatus: 204,
      initialPasswords: [] as string[],
      initialPasswordStatus: 204,
      desktopChallenges: [] as string[],
      /** Troca de e-mail com verificação: o servidor responde 202 com `pending_email`. */
      emailChangePending: false,
    },
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
    /** Moderação (adicional): banimentos e auditoria por servidor, overwrites por canal e o que o cliente enviou. */
    moderation: {
      bans: {} as Record<string, BanPayload[]>,
      audit: {} as Record<string, AuditEntryPayload[]>,
      overwrites: {} as Record<
        string,
        { type: string; target_id: string; allow: number; deny: number }[]
      >,
      banBodies: [] as { userId: string; reason?: string }[],
      unbans: [] as string[],
      nicks: [] as { userId: string; nick: string | null }[],
      voiceMutes: [] as { userId: string; muted: boolean }[],
      disconnects: [] as { channelId: string; userId: string }[],
      overwriteError: null as null | { status: number; detail: string },
      /** Convites cujo POST responde 403 `banned`. */
      bannedInvites: new Set<string>(),
    },
    /** Voz (Fase 5): erro forçado do token, tokens emitidos e PATCH /voice/state / leave recebidos. */
    voice: {
      tokenError: null as null | { status: number; detail: string },
      tokensFor: [] as string[],
      stateBodies: [] as { self_mute: boolean; self_deaf: boolean }[],
      stateStatus: 200,
      leaves: 0,
      /** Prévia da tela: envios (PUT), apagamentos (DELETE) e as prévias servidas (GET) por "canal/usuário". */
      previewPuts: [] as { channelId: string; type: string | null; size: number }[],
      previewDeletes: [] as string[],
      previewGets: [] as string[],
      previews: {} as Record<string, number[] | undefined>,
      previewPutStatus: 204,
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
      const b = (await request.json()) as {
        display_name?: string;
        bio?: string;
        pronouns?: string;
        banner_key?: string;
        banner_color?: number;
        remove_banner?: boolean;
      };
      state.patches.push(b);
      if (b.display_name !== undefined)
        state.user = { ...state.user, display_name: b.display_name || undefined };
      if (b.bio !== undefined) state.user = { ...state.user, bio: b.bio || undefined };
      if (b.pronouns !== undefined)
        state.user = { ...state.user, pronouns: b.pronouns || undefined };
      if (b.banner_color !== undefined)
        state.user = { ...state.user, banner_color: b.banner_color, banner_url: undefined };
      if (b.banner_key !== undefined)
        state.user = {
          ...state.user,
          banner_url: `https://s3.test/${b.banner_key}`,
          banner_color: undefined,
        };
      if (b.remove_banner)
        state.user = { ...state.user, banner_url: undefined, banner_color: undefined };
      return HttpResponse.json(state.user);
    }),
    http.post("*/api/users/me/banner", async ({ request }) => {
      const b = (await request.json()) as { content_type: string; size: number };
      state.account.bannerUploads.push(b);
      return HttpResponse.json({
        upload_url: "https://s3.test/upload/banner",
        key: `banners/${state.user.id}/1.png`,
      });
    }),
    http.post("*/api/auth/confirm-password", async ({ request }) => {
      const b = (await request.json()) as { password: string };
      if (b.password !== "senha-correta-1") return problem(422, "senha incorreta");
      state.account.confirmed = true;
      return HttpResponse.json({ confirmed_until: new Date(Date.now() + 600_000).toISOString() });
    }),
    http.post("*/api/users/me/password", async ({ request }) => {
      const b = (await request.json()) as { current_password: string; new_password: string };
      if (b.current_password !== "senha-correta-1") return problem(422, "senha atual incorreta");
      if (b.new_password === b.current_password)
        return problem(422, "a nova senha deve ser diferente da atual");
      state.account.passwordChanges.push(b);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete("*/api/guilds/:guildId", ({ params, request }) => {
      if (!state.account.confirmed)
        return problem(403, "confirme sua senha para continuar", [], {
          code: "password_confirmation_required",
        });
      state.requests.push({ method: "DELETE", path: new URL(request.url).pathname, search: "" });
      state.guilds = state.guilds.filter((g) => g.id !== params.guildId);
      return new HttpResponse(null, { status: 204 });
    }),
    http.put("*/api/users/me/email", async ({ request }) => {
      if (!state.account.confirmed)
        return problem(403, "confirme sua senha para continuar", [], {
          code: "password_confirmation_required",
        });
      const b = (await request.json()) as { email: string };
      if (b.email === "ocupado@spook.dev") return problem(409, "e-mail já cadastrado");
      state.account.emailChanges.push(b.email);
      if (state.auth.emailChangePending) {
        state.user = { ...state.user, pending_email: b.email };
        return HttpResponse.json(state.user, { status: 202 });
      }
      state.user = { ...state.user, email: b.email };
      return HttpResponse.json(state.user);
    }),
    // ---- E-mail e login social (adicional) ----
    http.get("*/api/auth/providers", () =>
      HttpResponse.json({
        providers: state.auth.providers,
        email_enabled: state.auth.emailEnabled,
      }),
    ),
    http.post("*/api/auth/email/verify", async ({ request }) => {
      const b = (await request.json()) as { token: string };
      state.auth.verifies.push(b.token);
      const r = state.auth.tokens[b.token] ?? "invalid";
      if (r === "expired")
        return problem(410, "link expirado ou já usado; peça um novo", [], {
          code: "token_expired",
        });
      if (r === "invalid")
        return problem(410, "link inválido; peça um novo", [], { code: "token_invalid" });
      if (r === "verified") state.user = { ...state.user, email_verified: true };
      return HttpResponse.json({ status: r, email: state.user.email });
    }),
    http.post("*/api/auth/email/resend", () => {
      state.auth.resends++;
      if (state.auth.resendStatus === 409)
        return problem(409, "seu e-mail já está verificado", [], { code: "already_verified" });
      if (state.auth.resendStatus === 429) return problem(429, "muitas tentativas");
      return new HttpResponse(null, { status: state.auth.resendStatus });
    }),
    http.post("*/api/auth/password/forgot", async ({ request }) => {
      const b = (await request.json()) as { email: string };
      state.auth.forgots.push(b.email);
      if (state.auth.forgotStatus === 429) return problem(429, "muitas tentativas");
      return new HttpResponse(null, { status: 202 });
    }),
    http.post("*/api/auth/password/reset", async ({ request }) => {
      const b = (await request.json()) as { token: string; new_password: string };
      state.auth.resets.push(b);
      const r = state.auth.tokens[b.token] ?? "invalid";
      if (r === "expired") return problem(410, "link expirado", [], { code: "token_expired" });
      if (r === "invalid") return problem(410, "link inválido", [], { code: "token_invalid" });
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("*/api/auth/social/pending", () =>
      state.auth.pending
        ? HttpResponse.json(state.auth.pending)
        : problem(410, "o cadastro expirou; entre com o provedor de novo"),
    ),
    http.post("*/api/auth/social/complete", async ({ request }) => {
      const b = (await request.json()) as { username: string };
      state.auth.completes.push(b.username);
      if (b.username === "ocupado") return problem(409, "nome de usuário já em uso");
      if (b.username === "admin") return problem(422, "esse nome de usuário é reservado");
      state.signedIn = true;
      state.user = { ...sampleUser, username: b.username, has_password: false };
      return HttpResponse.json({ user: state.user }, { status: 201 });
    }),
    http.get("*/api/users/me/login-methods", () => HttpResponse.json(state.auth.methods)),
    http.delete("*/api/auth/social/:provider", ({ params }) => {
      if (state.auth.unlinkStatus === 403)
        return problem(403, "confirme sua senha", [], { code: "password_confirmation_required" });
      if (state.auth.unlinkStatus === 409)
        return problem(409, "último método", [], { code: "last_login_method" });
      state.auth.unlinks.push(String(params.provider));
      state.auth.methods = {
        ...state.auth.methods,
        accounts: state.auth.methods.accounts.filter((a) => a.provider !== params.provider),
      };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post("*/api/users/me/password/initial", async ({ request }) => {
      const b = (await request.json()) as { new_password: string };
      if (state.auth.initialPasswordStatus === 403)
        return problem(403, "confirme sua identidade", [], {
          code: "password_confirmation_required",
        });
      state.auth.initialPasswords.push(b.new_password);
      state.user = { ...state.user, has_password: true };
      state.auth.methods = { ...state.auth.methods, has_password: true };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post("*/api/auth/desktop/authorize", async ({ request }) => {
      if (!state.signedIn) return problem(401, "autenticação necessária");
      const b = (await request.json()) as { code_challenge: string };
      state.auth.desktopChallenges.push(b.code_challenge);
      return HttpResponse.json({
        code: "codigo-de-uso-unico-123456",
        redirect_url: "spook://auth?code=codigo-de-uso-unico-123456",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    }),
    http.delete("*/api/users/me", async ({ request }) => {
      const b = (await request.json()) as { password: string };
      if (b.password !== "senha-correta-1") return problem(422, "senha incorreta");
      if (state.account.ownedGuilds.length > 0)
        return problem(409, "você é dono de servidores", [], {
          code: "owns_guilds",
          guilds: state.account.ownedGuilds,
        });
      state.account.deletes.push(state.user.id);
      state.signedIn = false;
      return new HttpResponse(null, { status: 204 });
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
          screen_preview: false,
        });
      }),
      http.put("*/api/channels/:channelId/voice/screen-preview", async ({ params, request }) => {
        const body = await request.arrayBuffer();
        state.voice.previewPuts.push({
          channelId: params.channelId as string,
          type: request.headers.get("content-type"),
          size: body.byteLength,
        });
        if (state.voice.previewPutStatus !== 204)
          return problem(state.voice.previewPutStatus, "não deu");
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("*/api/channels/:channelId/voice/screen-preview", ({ params }) => {
        state.voice.previewDeletes.push(params.channelId as string);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("*/api/channels/:channelId/voice/screen-preview/:userId", ({ params }) => {
        const key = `${params.channelId}/${params.userId}`;
        state.voice.previewGets.push(key);
        const bytes = state.voice.previews[key];
        if (!bytes) return problem(404, "prévia da transmissão não encontrada");
        return new HttpResponse(new Uint8Array(bytes), {
          headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
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
            topic: null,
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
          topic: null,
          owner_id: state.user.id,
          recipients: [me, ...(b.recipient_ids ?? []).map(lookup)],
        };
        state.dms.push(ch);
        return HttpResponse.json(ch, { status: 201 });
      }),
      http.get("*/api/channels/:channelId/my-permissions", ({ params }) => {
        const g = state.guilds.find((x) => x.channels?.some((c) => c.id === params.channelId));
        return HttpResponse.json({ permissions: g?.permissions ?? 0 });
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
      http.get("*/api/guilds/:guildId/bans", ({ params }) =>
        HttpResponse.json({
          bans: state.moderation.bans[params.guildId as string] ?? [],
          has_more: false,
        }),
      ),
      http.put("*/api/guilds/:guildId/bans/:userId", async ({ params, request }) => {
        const b = (await request.json().catch(() => ({}))) as { reason?: string };
        track(request, b);
        const gid = params.guildId as string;
        const uid = params.userId as string;
        state.moderation.banBodies.push({ userId: uid, reason: b.reason });
        const m = state.members[gid]?.find((x) => x.user_id === uid);
        state.members[gid] = (state.members[gid] ?? []).filter((x) => x.user_id !== uid);
        const bans = state.moderation.bans[gid] ?? [];
        state.moderation.bans[gid] = bans;
        bans.push({
          guild_id: gid,
          user_id: uid,
          username: m?.username ?? `user${uid}`,
          reason: b.reason ?? null,
          banned_by: state.user.id,
          banned_by_username: state.user.username,
          created_at: "2026-10-30T12:00:00Z",
        });
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete("*/api/guilds/:guildId/bans/:userId", ({ params, request }) => {
        track(request);
        const gid = params.guildId as string;
        state.moderation.unbans.push(params.userId as string);
        state.moderation.bans[gid] = (state.moderation.bans[gid] ?? []).filter(
          (x) => x.user_id !== params.userId,
        );
        return new HttpResponse(null, { status: 204 });
      }),
      http.get("*/api/guilds/:guildId/audit-logs", ({ params, request }) => {
        track(request);
        const q = new URL(request.url).searchParams;
        const limit = Number(q.get("limit") ?? 50);
        const before = q.get("before");
        let all = [...(state.moderation.audit[params.guildId as string] ?? [])].sort(
          (a, z) => Number(z.id) - Number(a.id),
        );
        if (q.get("action")) all = all.filter((e) => e.action === q.get("action"));
        if (q.get("actor")) all = all.filter((e) => e.actor?.id === q.get("actor"));
        if (before) all = all.filter((e) => Number(e.id) < Number(before));
        return HttpResponse.json({ entries: all.slice(0, limit), has_more: all.length > limit });
      }),
      http.get("*/api/channels/:channelId/overwrites", ({ params }) =>
        HttpResponse.json(state.moderation.overwrites[params.channelId as string] ?? []),
      ),
      http.put(
        "*/api/channels/:channelId/overwrites/:type/:targetId",
        async ({ params, request }) => {
          const b = (await request.json()) as { allow: number; deny: number };
          track(request, b);
          if (state.moderation.overwriteError) {
            const e = state.moderation.overwriteError;
            return problem(e.status, e.detail);
          }
          const cid = params.channelId as string;
          const list = (state.moderation.overwrites[cid] ?? []).filter(
            (o) => !(o.type === params.type && o.target_id === params.targetId),
          );
          if (b.allow || b.deny)
            list.push({
              type: params.type as string,
              target_id: params.targetId as string,
              allow: b.allow,
              deny: b.deny,
            });
          state.moderation.overwrites[cid] = list;
          return HttpResponse.json({
            type: params.type,
            target_id: params.targetId,
            allow: b.allow,
            deny: b.deny,
          });
        },
      ),
      http.patch("*/api/guilds/:guildId/members/:userId/nick", async ({ params, request }) => {
        const b = (await request.json()) as { nick: string | null };
        track(request, b);
        const gid = params.guildId as string;
        const uid = params.userId === "@me" ? state.user.id : (params.userId as string);
        state.moderation.nicks.push({ userId: uid, nick: b.nick });
        const m = state.members[gid]?.find((x) => x.user_id === uid);
        if (!m) return problem(404, "membro não encontrado");
        m.nickname = b.nick || null;
        return HttpResponse.json(m);
      }),
      http.put("*/api/guilds/:guildId/members/:userId/voice-mute", ({ params, request }) => {
        track(request);
        state.moderation.voiceMutes.push({ userId: params.userId as string, muted: true });
        const m = state.members[params.guildId as string]?.find((x) => x.user_id === params.userId);
        if (m) m.voice_muted = true;
        return HttpResponse.json(m ?? {});
      }),
      http.delete("*/api/guilds/:guildId/members/:userId/voice-mute", ({ params, request }) => {
        track(request);
        state.moderation.voiceMutes.push({ userId: params.userId as string, muted: false });
        const m = state.members[params.guildId as string]?.find((x) => x.user_id === params.userId);
        if (m) m.voice_muted = false;
        return HttpResponse.json(m ?? {});
      }),
      http.post("*/api/channels/:channelId/voice/:userId/disconnect", ({ params, request }) => {
        track(request);
        state.moderation.disconnects.push({
          channelId: params.channelId as string,
          userId: params.userId as string,
        });
        return new HttpResponse(null, { status: 204 });
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
        if (state.moderation.bannedInvites.has(params.code as string))
          return problem(403, "Você foi banido deste servidor e não pode entrar por convite.", [], {
            code: "banned",
          });
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
          kind: "default",
          mention_everyone: false,
          mention_here: false,
          mention_roles: [],
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
