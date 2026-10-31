// Cliente da API gerado pelo orval a partir de server/api/openapi.yaml (`pnpm --filter @spook/shared generate`).
// Tipos/schemas do gateway entram aqui a partir da Fase 3.

export * from "./api/endpoints/auth/auth";
export * from "./api/endpoints/channels/channels";
export * from "./api/endpoints/guilds/guilds";
export * from "./api/endpoints/invites/invites";
export * from "./api/endpoints/messages/messages";
export * from "./api/endpoints/users/users";
export * from "./api/model";
export * as schemas from "./api/zod/index.zod";
export type { ApiFieldError } from "./http";
export { ApiError, isApiError, shouldRetry } from "./http";
export * from "./permissions";
