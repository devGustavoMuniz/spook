// Contrato do gateway (SPEC 5.3) em Zod. É a fonte dos tipos de payload do cliente; o teste de contrato
// (`contract.test.ts`) valida cada exemplo de `fixtures/gateway-events.json`, gerado pelo Go.
import { z } from "zod";

// ---- Payloads de domínio (mesmo formato da API REST) ----

export const authorPayloadSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

export const messagePayloadSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  author: authorPayloadSchema,
  content: z.string(),
  edited_at: z.string().nullable(),
  created_at: z.string(),
});

export const recipientPayloadSchema = z.object({
  id: z.string(),
  username: z.string(),
  display_name: z.string().optional(),
  avatar_url: z.string().optional(),
});

export const channelPayloadSchema = z.object({
  id: z.string(),
  type: z.number().int(),
  guild_id: z.string().nullable(),
  parent_id: z.string().nullable(),
  name: z.string(),
  position: z.number().int(),
  last_message_id: z.string().nullable(),
  created_at: z.string(),
  // Só em DMs (tipo 3 e 4): o dono do grupo e todos os participantes, inclusive quem consulta.
  owner_id: z.string().optional(),
  recipients: z.array(recipientPayloadSchema).nullable().optional(),
});

export const rolePayloadSchema = z.object({
  id: z.string(),
  guild_id: z.string(),
  name: z.string(),
  color: z.number().int().nullable(),
  position: z.number().int(),
  permissions: z.number().int(),
  is_everyone: z.boolean(),
});

export const memberPayloadSchema = z.object({
  guild_id: z.string(),
  user_id: z.string(),
  nickname: z.string().nullable(),
  joined_at: z.string(),
  username: z.string(),
  display_name: z.string().optional(),
  avatar_url: z.string().optional(),
  role_ids: z.array(z.string()).nullable(),
});

export const guildPayloadSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon_key: z.string().nullable(),
  icon_url: z.string().optional(),
  owner_id: z.string(),
  created_at: z.string(),
});

export const guildDetailPayloadSchema = guildPayloadSchema.extend({
  roles: z.array(rolePayloadSchema).nullable(),
  channels: z.array(channelPayloadSchema).nullable(),
  permissions: z.number().int(),
  is_owner: z.boolean(),
  my_role_ids: z.array(z.string()).nullable(),
});

// ---- Payloads próprios do gateway ----

export const helloDataSchema = z.object({ heartbeat_interval: z.number().int().positive() });
export const identifyDataSchema = z.object({ client: z.string().optional() });
export const resumeDataSchema = z.object({ session_id: z.string(), seq: z.number().int() });

export const presenceStatusSchema = z.enum(["online", "idle", "offline"]);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;
/** Status que o cliente pode sinalizar (op 12); offline é decidido pelo servidor. */
export const clientPresenceStatusSchema = z.enum(["online", "idle"]);
export type ClientPresenceStatus = z.infer<typeof clientPresenceStatusSchema>;
export const setPresenceDataSchema = z.object({ status: clientPresenceStatusSchema });

export const voiceStatePayloadSchema = z.object({
  guild_id: z.string().nullable(),
  channel_id: z.string().nullable(),
  user_id: z.string(),
  self_mute: z.boolean(),
  self_deaf: z.boolean(),
  self_video: z.boolean(),
  self_screen: z.boolean(),
});

export const readyDataSchema = z.object({
  session_id: z.string(),
  user: z.object({ id: z.string() }),
  guilds: z.array(guildDetailPayloadSchema),
  // Fase 4: as DMs do usuário e o snapshot de presença (só online/idle, sem o próprio usuário).
  // O servidor sempre manda arrays; o `default` tolera um servidor anterior à Fase 4.
  private_channels: z.array(channelPayloadSchema).nullable().default([]),
  presences: z.array(z.object({ user_id: z.string(), status: presenceStatusSchema })).default([]),
  // Fase 5: quem está em voz agora (servidores que o usuário vê e as DMs dele); sempre array.
  voice_states: z.array(voiceStatePayloadSchema).nullable().default([]),
});

export const resumedDataSchema = z.object({
  session_id: z.string(),
  replayed: z.number().int().nonnegative(),
});

export const guildDeleteDataSchema = z.object({ id: z.string() });
export const guildMemberRemoveDataSchema = z.object({ guild_id: z.string(), user_id: z.string() });
export const messageDeleteDataSchema = z.object({
  id: z.string(),
  channel_id: z.string(),
  guild_id: z.string().nullable().optional(),
});
export const roleDeleteDataSchema = z.object({ guild_id: z.string(), role_id: z.string() });

// Fases 4 a 6.
export const typingStartDataSchema = z.object({
  channel_id: z.string(),
  guild_id: z.string().nullable(),
  user_id: z.string(),
  timestamp: z.number().int(),
});
export const presenceUpdateDataSchema = z.object({
  user_id: z.string(),
  status: presenceStatusSchema,
});
export const voiceStateUpdateDataSchema = voiceStatePayloadSchema;
export const readStateUpdateDataSchema = z.object({
  channel_id: z.string(),
  last_read_message_id: z.string(),
  mention_count: z.number().int().nonnegative(),
});

/** Payload (`d`) de cada evento de dispatch, pelo nome (`t`). */
export const eventSchemas = {
  READY: readyDataSchema,
  RESUMED: resumedDataSchema,
  MESSAGE_CREATE: messagePayloadSchema,
  MESSAGE_UPDATE: messagePayloadSchema,
  MESSAGE_DELETE: messageDeleteDataSchema,
  GUILD_CREATE: guildDetailPayloadSchema,
  GUILD_UPDATE: guildPayloadSchema,
  GUILD_DELETE: guildDeleteDataSchema,
  GUILD_MEMBER_ADD: memberPayloadSchema,
  GUILD_MEMBER_UPDATE: memberPayloadSchema,
  GUILD_MEMBER_REMOVE: guildMemberRemoveDataSchema,
  CHANNEL_CREATE: channelPayloadSchema,
  CHANNEL_UPDATE: channelPayloadSchema,
  CHANNEL_DELETE: channelPayloadSchema,
  ROLE_CREATE: rolePayloadSchema,
  ROLE_UPDATE: rolePayloadSchema,
  ROLE_DELETE: roleDeleteDataSchema,
  TYPING_START: typingStartDataSchema,
  PRESENCE_UPDATE: presenceUpdateDataSchema,
  VOICE_STATE_UPDATE: voiceStateUpdateDataSchema,
  READ_STATE_UPDATE: readStateUpdateDataSchema,
} as const;

export type GatewayEventName = keyof typeof eventSchemas;
export type GatewayEventData<K extends GatewayEventName = GatewayEventName> = z.infer<
  (typeof eventSchemas)[K]
>;
/** União discriminada por `t`: `{ t: "MESSAGE_CREATE", d: … }`. */
export type GatewayEvent = {
  [K in GatewayEventName]: { t: K; d: GatewayEventData<K> };
}[GatewayEventName];

export const isGatewayEventName = (t: string): t is GatewayEventName =>
  Object.hasOwn(eventSchemas, t);

// ---- Frames ----

/** Op codes (SPEC 5.3). */
export const Op = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  Resume: 3,
  InvalidSession: 9,
  Hello: 10,
  Ack: 11,
  /** Cliente -> servidor: `{status: "online" | "idle"}` da sessão (Fase 4). */
  PresenceUpdate: 12,
} as const;

const seq = z.number().int().nullable();

/** Envelope genérico `{op, t, s, d}`; o `d` é validado por op/evento depois. */
export const frameSchema = z.object({
  op: z.number().int(),
  t: z.string().nullable(),
  s: seq,
  d: z.unknown(),
});
export type GatewayFrame = z.infer<typeof frameSchema>;

const control = <O extends number, D extends z.ZodType>(op: O, d: D) =>
  z.object({ op: z.literal(op), t: z.null(), s: z.null(), d });

export const helloFrameSchema = control(Op.Hello, helloDataSchema);
export const ackFrameSchema = control(Op.Ack, z.null());
export const invalidSessionFrameSchema = control(Op.InvalidSession, z.boolean());
export const heartbeatFrameSchema = control(Op.Heartbeat, z.number().int().nullable());
export const identifyFrameSchema = control(Op.Identify, identifyDataSchema);
export const resumeFrameSchema = control(Op.Resume, resumeDataSchema);
export const setPresenceFrameSchema = control(Op.PresenceUpdate, setPresenceDataSchema);

/** Frame de dispatch de um evento específico (`t` fixo, `d` tipado). */
export const dispatchFrameSchema = <K extends GatewayEventName>(t: K) =>
  z.object({ op: z.literal(Op.Dispatch), t: z.literal(t), s: seq, d: eventSchemas[t] });

export type CloseCodeName =
  | "going_away"
  | "unknown"
  | "invalid_op"
  | "session_taken_over"
  | "not_identified"
  | "already_identified"
  | "identify_timeout"
  | "slow_consumer"
  | "heartbeat_timeout"
  | "rate_limited";

/** Códigos de fechamento (mesmos nomes de `close_codes` do fixture). */
export const CloseCode: Readonly<Record<CloseCodeName, number>> = {
  going_away: 1001,
  unknown: 4000,
  invalid_op: 4001,
  session_taken_over: 4002,
  not_identified: 4003,
  already_identified: 4005,
  identify_timeout: 4006,
  slow_consumer: 4008,
  heartbeat_timeout: 4009,
  rate_limited: 4029,
};

/** Só a 4002 não reconecta: outra conexão é a dona da sessão. */
export const shouldReconnectOnClose = (code: number) => code !== CloseCode.session_taken_over;
