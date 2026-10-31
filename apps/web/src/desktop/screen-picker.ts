// Seletor de fonte de compartilhamento (telas e janelas vindas do Rust). A engine pede a fonte por aqui;
// o diálogo (`ScreenSourceDialog`, montado no app desktop) responde. Sem diálogo montado, cancela.

export type ScreenSource = { id: string; name: string; kind: "screen" | "window" };

/** No Linux o Rust devolve só "portal": quem escolhe é o seletor do próprio sistema. */
export const PORTAL_SOURCE = "portal";

type Pending = { sources: ScreenSource[]; resolve: (id: string | null) => void };
type Listener = (pending: Pending | null) => void;

let listener: Listener | null = null;
let current: Pending | null = null;

/** Usado pelo `ScreenSourceDialog`. Devolve a função que desinscreve. */
export function subscribeScreenPicker(l: Listener): () => void {
  listener = l;
  l(current);
  return () => {
    if (listener === l) listener = null;
  };
}

/** Abre o diálogo e devolve o `id` escolhido, ou `null` se cancelou (ou não há diálogo montado). */
export function pickScreenSource(sources: ScreenSource[]): Promise<string | null> {
  const portal = sources.length === 1 && sources[0]?.id === PORTAL_SOURCE;
  if (portal) return Promise.resolve(PORTAL_SOURCE);
  if (!listener) return Promise.resolve(null);
  // Um pedido novo cancela o anterior.
  current?.resolve(null);
  return new Promise((resolve) => {
    const pending: Pending = {
      sources,
      resolve: (id) => {
        if (current === pending) {
          current = null;
          listener?.(null);
        }
        resolve(id);
      },
    };
    current = pending;
    listener?.(pending);
  });
}

/** Só para testes. */
export function resetScreenPicker() {
  current?.resolve(null);
  current = null;
  listener = null;
}
