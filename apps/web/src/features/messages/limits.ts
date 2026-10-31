export const MAX_MESSAGE_LENGTH = 2000;

/** O servidor conta runes (pontos de código), não unidades UTF-16. */
export const runeCount = (s: string) => [...s].length;
