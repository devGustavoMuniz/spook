import { describe, expect, it } from "vitest";
import { RnnoiseTrackProcessor } from "./noise-processor";

// Arquivo à parte: a lib de ruído estende `AudioWorkletNode` ao ser carregada e o módulo (com falha) fica em cache.
describe("RnnoiseTrackProcessor em navegador sem AudioWorklet", () => {
  it("o init falha (a engine então rebaixa para Padrão com aviso)", async () => {
    expect(typeof AudioWorkletNode).toBe("undefined");
    await expect(
      new RnnoiseTrackProcessor().init({ track: {} as MediaStreamTrack }),
    ).rejects.toThrow();
  });
});
