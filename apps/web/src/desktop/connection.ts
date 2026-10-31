import { createGatewayTicket, gatewayUrl, getApiBaseUrl } from "@spook/shared";
import { isTauri } from "./runtime";

/**
 * Como o gateway conecta. Web: mesma origem, autenticada pelo cookie. Desktop: URL absoluta do backend e
 * ticket de uso único (`POST /api/gateway/ticket` com Bearer), pois o WebSocket do webview não envia
 * `Authorization` nem o cookie de outra origem.
 */
export function gatewayConnection() {
  if (!isTauri()) return { url: gatewayUrl(window.location.origin), client: "web" as const };
  return {
    url: gatewayUrl(getApiBaseUrl() || window.location.origin),
    client: "desktop" as const,
    getTicket: async () => (await createGatewayTicket()).ticket,
  };
}
