import { listReadStates } from "@spook/shared";
import { useReadStateStore } from "./read-state";

let timer: ReturnType<typeof setTimeout> | undefined;
let inflight = false;

/**
 * Refaz o snapshot de não lidas pelo `GET /users/@me/read-states` (reconexão com buraco, ack parcial
 * em outra sessão). Agrupa chamadas próximas: várias numa rajada viram uma só.
 */
export function reloadReadStates(delayMs = 300) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    if (inflight) return reloadReadStates(delayMs);
    inflight = true;
    try {
      const res = await listReadStates();
      useReadStateStore.getState().replaceAll(res.read_states ?? []);
    } catch {
      // Sem rede ou sessão caída: o próximo READY/evento reconcilia.
    } finally {
      inflight = false;
    }
  }, delayMs);
}

export function cancelReloadReadStates() {
  clearTimeout(timer);
}
