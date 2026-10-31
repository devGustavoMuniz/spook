import type { GatewaySocketFactory } from "@spook/shared";

// Ponto de injeção do WebSocket: em produção fica vazio (o cliente usa o `WebSocket` do navegador);
// os testes põem um falso (o MSW troca o `WebSocket` global e não deixa substituí-lo).
let override: GatewaySocketFactory | undefined;

export const setGatewaySocketFactory = (factory: GatewaySocketFactory | undefined) => {
  override = factory;
};
export const gatewaySocketFactory = (): GatewaySocketFactory | undefined => override;
