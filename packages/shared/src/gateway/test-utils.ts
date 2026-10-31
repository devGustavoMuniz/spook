// WebSocket falso para os testes do cliente do gateway (e reaproveitável por outros pacotes).
import type { GatewaySocket } from "./client";

export type SentFrame = { op: number; t: string | null; s: number | null; d: unknown };

export class FakeSocket implements GatewaySocket {
  static instances: FakeSocket[] = [];
  static reset() {
    FakeSocket.instances = [];
  }
  static get last(): FakeSocket {
    const s = FakeSocket.instances.at(-1);
    if (!s) throw new Error("nenhum socket criado");
    return s;
  }

  onopen: GatewaySocket["onopen"] = null;
  onmessage: GatewaySocket["onmessage"] = null;
  onclose: GatewaySocket["onclose"] = null;
  onerror: GatewaySocket["onerror"] = null;
  sent: SentFrame[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code?: number, reason?: string) {
    this.closedWith = { code, reason };
  }

  /** Servidor -> cliente. */
  receive(frame: { op: number; t?: string | null; s?: number | null; d?: unknown }) {
    this.onmessage?.({ data: JSON.stringify({ t: null, s: null, d: null, ...frame }) });
  }
  receiveRaw(data: string) {
    this.onmessage?.({ data });
  }
  dispatch(t: string, s: number | null, d: unknown) {
    this.receive({ op: 0, t, s, d });
  }
  hello(interval = 41_000) {
    this.receive({ op: 10, d: { heartbeat_interval: interval } });
  }
  ack() {
    this.receive({ op: 11 });
  }
  /** Servidor fecha a conexão com o código dado. */
  serverClose(code: number) {
    this.onclose?.({ code });
  }
  ops(op: number) {
    return this.sent.filter((f) => f.op === op);
  }
}
