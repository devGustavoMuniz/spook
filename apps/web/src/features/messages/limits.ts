export const MAX_MESSAGE_LENGTH = 2000;

/** O servidor conta runes (pontos de código), não unidades UTF-16. */
export const runeCount = (s: string) => [...s].length;

/** O contador "n/2000" só aparece a partir daqui (90% do limite). */
export const COUNTER_FROM = 1800;
