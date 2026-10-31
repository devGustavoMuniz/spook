import { describe, expect, it } from "vitest";
import { decodeFrame, toBytes } from "./frame-wire";

function build(header: object, jpeg: number[]) {
  const json = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + json.length + jpeg.length);
  new DataView(out.buffer).setUint32(0, json.length, true);
  out.set(json, 4);
  out.set(jpeg, 4 + json.length);
  return out;
}

const header = {
  trackId: "TR_1",
  participantId: "42",
  source: "screen",
  width: 1280,
  height: 720,
  timestamp: 1700000000123,
};

describe("decodeFrame", () => {
  it("separa o cabeçalho JSON e o JPEG", () => {
    const f = decodeFrame(build(header, [0xff, 0xd8, 9, 0xff, 0xd9]));
    expect(f?.header).toEqual(header);
    expect([...(f?.jpeg ?? [])]).toEqual([0xff, 0xd8, 9, 0xff, 0xd9]);
  });

  it("aceita ArrayBuffer, Uint8Array com offset e lista de bytes", () => {
    const bytes = build(header, [1, 2, 3]);
    expect(decodeFrame(bytes.buffer)?.header.trackId).toBe("TR_1");
    const padded = new Uint8Array(bytes.length + 5);
    padded.set(bytes, 5);
    expect(decodeFrame(padded.subarray(5))?.header.trackId).toBe("TR_1");
    expect(decodeFrame([...bytes])?.header.trackId).toBe("TR_1");
  });

  it("recusa entradas inválidas", () => {
    expect(decodeFrame(null)).toBeNull();
    expect(decodeFrame("x")).toBeNull();
    expect(decodeFrame(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeFrame(new Uint8Array([255, 255, 255, 255, 1]))).toBeNull();
    expect(decodeFrame(new Uint8Array([0, 0, 0, 0, 1]))).toBeNull();
    expect(decodeFrame(build({ ...header, width: 0 }, [1]))).toBeNull();
    expect(decodeFrame(build({ nada: true }, [1]))).toBeNull();
    const bad = new Uint8Array([2, 0, 0, 0, 0x7b, 0x7b]);
    expect(decodeFrame(bad)).toBeNull();
  });

  it("toBytes", () => {
    expect(toBytes({})).toBeNull();
    expect(toBytes([1, 2])).toEqual(new Uint8Array([1, 2]));
  });
});
