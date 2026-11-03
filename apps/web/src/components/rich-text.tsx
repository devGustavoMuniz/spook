import { Fragment, type ReactNode } from "react";

type Tags = Record<string, (children: string) => ReactNode>;

/**
 * Renderiza uma frase traduzida com marcação simples (`<b>`, `<q>`, `<code>`...): cada tag vira o nó
 * devolvido por `tags[nome]`. Sem aninhamento; o texto fora das tags é mantido como está.
 */
export function RichText({ text, tags }: { text: string; tags: Tags }) {
  const out: ReactNode[] = [];
  const re = /<(\w+)>(.*?)<\/\1>/g;
  let last = 0;
  let i = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const render = tags[m[1] as string];
    out.push(<Fragment key={i++}>{render ? render(m[2] as string) : m[2]}</Fragment>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return <>{out}</>;
}
