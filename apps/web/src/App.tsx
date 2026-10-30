import type { HealthStatus } from "@spook/shared";
import { useEffect, useState } from "react";

type State = "loading" | "ok" | "down";

export function App() {
  const [state, setState] = useState<State>("loading");

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/healthz", { signal: ctrl.signal })
      .then((r) => r.json() as Promise<HealthStatus>)
      .then((h) => setState(h.status === "ok" ? "ok" : "down"))
      .catch(() => !ctrl.signal.aborted && setState("down"));
    return () => ctrl.abort();
  }, []);

  return (
    <main>
      <img src="/icon-192.png" alt="Spook" width={96} height={96} />
      <h1>Spook</h1>
      <p>Seus servidores, sua galera, num só lugar.</p>
      <p className="status" data-state={state}>
        {state === "loading" && "Verificando backend…"}
        {state === "ok" && "Backend online"}
        {state === "down" && "Backend indisponível"}
      </p>
    </main>
  );
}
