/** Compara ids Snowflake (decimais em string, que não cabem em number): negativo, 0 ou positivo. */
export function compareIds(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** O id vale 0 ou é vazio (sem leitura registrada). */
export const isZeroId = (id: string | null | undefined) => !id || /^0*$/.test(id);
