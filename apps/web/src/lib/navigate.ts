/**
 * Navegação completa do navegador (sai do app de página única): início do fluxo OAuth e deep link do desktop.
 * Isolada aqui para os testes substituírem (jsdom não implementa navegação).
 */
export function navigateTo(url: string): void {
  window.location.assign(url);
}
