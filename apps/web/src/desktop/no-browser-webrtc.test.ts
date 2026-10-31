// RF12.2: no desktop a mídia é NATIVA (Rust). Este teste falha se o código do modo desktop tocar nas
// APIs de mídia/WebRTC do navegador, estática e dinamicamente.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeVoiceEngine, type NativeDeps } from "./native-engine";

const dir = dirname(fileURLToPath(import.meta.url));

const FORBIDDEN = [
  /getUserMedia/,
  /getDisplayMedia/,
  /RTCPeerConnection/,
  /webkitRTCPeerConnection/,
  /RTCSessionDescription/,
  /navigator\.mediaDevices/,
  /mediaDevices/,
  /MediaRecorder/,
  /from\s+["']livekit-client["']/,
  /import\(\s*["']livekit-client["']\s*\)/,
];

function sources(): { file: string; text: string }[] {
  return readdirSync(dir)
    .filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.(ts|tsx)$/.test(f))
    .map((file) => ({ file, text: readFileSync(join(dir, file), "utf8") }));
}

describe("modo desktop sem WebRTC do navegador", () => {
  it("nenhum arquivo de src/desktop usa as APIs de mídia do navegador", () => {
    const files = sources();
    expect(files.length).toBeGreaterThan(5);
    for (const { file, text } of files) {
      // comentários podem citar as APIs proibidas; só o código conta
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
      for (const re of FORBIDDEN) expect(code, `${file} usa ${re}`).not.toMatch(re);
    }
  });

  describe("em execução", () => {
    afterEach(() => vi.unstubAllGlobals());

    it("usar todos os métodos da engine nunca chama getUserMedia/getDisplayMedia/RTCPeerConnection", async () => {
      const boom = (name: string) =>
        vi.fn(() => {
          throw new Error(`${name} proibido no desktop`);
        });
      const media = {
        getUserMedia: boom("getUserMedia"),
        getDisplayMedia: boom("getDisplayMedia"),
        enumerateDevices: boom("enumerateDevices"),
      };
      Object.defineProperty(navigator, "mediaDevices", { value: media, configurable: true });
      const rtc = boom("RTCPeerConnection");
      vi.stubGlobal("RTCPeerConnection", rtc);
      vi.stubGlobal("webkitRTCPeerConnection", rtc);

      const deps: NativeDeps = {
        invoke: (async (cmd: string) =>
          cmd === "voice_list_screen_sources"
            ? [{ id: "display:1", name: "Tela 1", kind: "screen" }]
            : cmd === "voice_list_devices"
              ? []
              : undefined) as NativeDeps["invoke"],
        createChannel: (async (onmessage: unknown) => ({
          onmessage,
        })) as NativeDeps["createChannel"],
        pickScreenSource: async () => "display:1",
      };
      const engine = createNativeVoiceEngine(deps);
      await engine.connect({ url: "wss://x.example.com", token: "a.b.c" });
      await engine.setMicrophoneEnabled(true);
      await engine.setCameraEnabled(true);
      await engine.setScreenShareEnabled(true, { audio: true });
      engine.setDeafened(true);
      await engine.resumeAudio();
      await engine.listDevices("audioinput");
      await engine.listDevices("videoinput");
      await engine.setDevice("audioinput", "x");
      await engine.setScreenShareEnabled(false);
      await engine.setCameraEnabled(false);
      await engine.setMicrophoneEnabled(false);
      await engine.disconnect();

      expect(media.getUserMedia).not.toHaveBeenCalled();
      expect(media.getDisplayMedia).not.toHaveBeenCalled();
      expect(media.enumerateDevices).not.toHaveBeenCalled();
      expect(rtc).not.toHaveBeenCalled();
    });
  });
});
