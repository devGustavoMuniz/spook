import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeXhr } from "@/test/xhr";
import { putWithProgress, UploadAbortError, UploadError } from "./upload";

const file = new File(["abc"], "a.txt", { type: "text/plain" });

beforeEach(() => {
  FakeXhr.all = [];
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
});
afterEach(() => vi.unstubAllGlobals());

describe("putWithProgress", () => {
  it("envia o arquivo cru com exatamente os cabeçalhos devolvidos e informa o progresso", async () => {
    const seen: number[] = [];
    const p = putWithProgress("https://s/up", file, (n) => seen.push(n), {
      headers: { "Content-Type": "text/plain" },
    });
    const xhr = FakeXhr.all[0] as FakeXhr;
    expect(xhr.method).toBe("PUT");
    expect(xhr.url).toBe("https://s/up");
    expect(xhr.headers).toEqual({ "Content-Type": "text/plain" });
    expect(xhr.body).toBe(file);
    xhr.progress(1, 4);
    xhr.progress(3, 4);
    xhr.finish(200);
    await p;
    expect(seen).toEqual([25, 75, 100]);
  });

  it("sem cabeçalhos informados usa o tipo do arquivo", () => {
    void putWithProgress("https://s/up", file, () => {});
    expect((FakeXhr.all[0] as FakeXhr).headers).toEqual({ "Content-Type": "text/plain" });
  });

  it("status de erro vira UploadError com o código", async () => {
    const p = putWithProgress("https://s/up", file, () => {});
    (FakeXhr.all[0] as FakeXhr).finish(403);
    await expect(p).rejects.toMatchObject({ name: "UploadError", status: 403 });
    await p.catch((e) => expect(e).toBeInstanceOf(UploadError));
  });

  it("erro de rede vira UploadError com status 0", async () => {
    const p = putWithProgress("https://s/up", file, () => {});
    (FakeXhr.all[0] as FakeXhr).onerror?.();
    await expect(p).rejects.toMatchObject({ status: 0 });
  });

  it("o AbortSignal cancela o XHR", async () => {
    const ctl = new AbortController();
    const p = putWithProgress("https://s/up", file, () => {}, { signal: ctl.signal });
    ctl.abort();
    await expect(p).rejects.toBeInstanceOf(UploadAbortError);
    expect((FakeXhr.all[0] as FakeXhr).aborted).toBe(true);
  });

  it("signal já abortado nem abre o XHR", async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      putWithProgress("https://s/up", file, () => {}, { signal: ctl.signal }),
    ).rejects.toBeInstanceOf(UploadAbortError);
    expect(FakeXhr.all).toHaveLength(0);
  });
});
