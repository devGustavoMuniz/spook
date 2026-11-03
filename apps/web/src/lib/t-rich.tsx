import { Fragment, type ReactNode } from "react";
import type { MessageKey, TFunction } from "@/i18n";

const MARK = "\u0000";

/**
 * Traduz uma frase com UM trecho em destaque (JSX): `{name}` vira o nó `node` no lugar certo para
 * cada idioma, sem montar a frase por partes. Ex.: `tRich(t, "chat.row.joined", "name", <strong>x</strong>)`.
 */
export function tRich(
  t: TFunction,
  key: MessageKey,
  param: string,
  node: ReactNode,
  params: Record<string, string | number> = {},
): ReactNode {
  const parts = t(key, { ...params, [param]: MARK }).split(MARK);
  return parts.map((part, i) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: partes fixas da frase
    <Fragment key={i}>
      {i > 0 ? node : null}
      {part}
    </Fragment>
  ));
}
