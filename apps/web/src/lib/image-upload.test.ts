import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeXhr } from "@/test/xhr";
import { uploadCropped } from "./image-upload";

const gif = new File([new Uint8Array(4)], "a.gif", { type: "image/gif" });
const rect = { x: 1, y: 2, w: 30, h: 30 };

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

async function run(opts: Partial<Parameters<typeof uploadCropped>[0]>) {
  const presign = vi.fn().mockResolvedValue({ upload_url: "https://s/up", key: "avatars/1/9.gif" });
  const p = uploadCropped({
    result: { mode: "gif", file: gif, rect },
    presign,
    onProgress: () => {},
    ...opts,
  });
  await vi.waitFor(() => expect(FakeXhr.all).toHaveLength(1));
  FakeXhr.all[0]?.finish(200);
  return { p, presign };
}

describe("uploadCropped", () => {
  it("GIF com recorte: sobe o original e usa a chave devolvida pelo servidor", async () => {
    const cropGif = vi.fn().mockResolvedValue({ key: "avatars/1/10.gif" });
    const { p, presign } = await run({ cropGif });
    expect(await p).toEqual({ key: "avatars/1/10.gif", fallback: false });
    expect(presign).toHaveBeenCalledWith("image/gif", 4);
    expect(cropGif).toHaveBeenCalledWith("avatars/1/9.gif", rect);
  });

  it("422 do servidor cai no original (fallback)", async () => {
    const cropGif = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { status: 422 }));
    const { p } = await run({ cropGif });
    expect(await p).toEqual({ key: "avatars/1/9.gif", fallback: true });
  });

  it("outros erros propagam", async () => {
    const cropGif = vi.fn().mockRejectedValue(Object.assign(new Error("x"), { status: 429 }));
    const { p } = await run({ cropGif });
    await expect(p).rejects.toMatchObject({ status: 429 });
  });

  it("sem recorte (rect nulo ou arquivo pronto) não chama o servidor", async () => {
    const cropGif = vi.fn();
    const { p } = await run({ cropGif, result: { mode: "gif", file: gif, rect: null } });
    expect(await p).toEqual({ key: "avatars/1/9.gif", fallback: false });
    expect(cropGif).not.toHaveBeenCalled();
  });
});
