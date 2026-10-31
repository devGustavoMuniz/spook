import { ApiError, type UploadPayload } from "@spook/shared";
import { describe, expect, it, vi } from "vitest";
import { UploadAbortError, UploadError } from "@/lib/upload";
import { type QueueDeps, UploadQueue } from "./upload-queue";

const png = (name = "a.png", size = 10) =>
  new File([new Uint8Array(size)], name, { type: "image/png" });

type Put = QueueDeps["put"];

/** Dependências falsas: cada `put` fica pendente até o teste resolver/rejeitar/emitir progresso. */
function setup(opts: { concurrency?: number } = {}) {
  let n = 0;
  const puts: {
    url: string;
    file: File;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    progress: (p: number) => void;
    resolve: () => void;
    reject: (e: unknown) => void;
  }[] = [];
  const requestUpload = vi.fn(
    async (_channel: string, body: { filename: string; content_type: string; size: number }) => {
      n++;
      return {
        id: `up${n}`,
        upload_url: `https://s/${n}`,
        headers: { "Content-Type": body.content_type },
        expires_in: 300,
      } satisfies UploadPayload;
    },
  );
  const put: Put = (url, file, progress, o) =>
    new Promise<void>((resolve, reject) => {
      puts.push({ url, file, headers: o?.headers, signal: o?.signal, progress, resolve, reject });
      o?.signal?.addEventListener("abort", () => reject(new UploadAbortError()));
    });
  const revoked: string[] = [];
  const queue = new UploadQueue("c1", {
    requestUpload,
    put,
    createPreviewUrl: (f) => `blob:${f.name}`,
    revokePreviewUrl: (u) => revoked.push(u),
    concurrency: opts.concurrency,
  });
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { queue, puts, requestUpload, revoked, flush };
}

describe("UploadQueue", () => {
  it("pede a URL, envia com os cabeçalhos devolvidos, mostra progresso e termina", async () => {
    const { queue, puts, requestUpload, flush } = setup();
    expect(queue.add([png("foto.png", 100)]).rejected).toEqual([]);
    expect(queue.getSnapshot()[0]).toMatchObject({
      status: "uploading",
      progress: 0,
      previewUrl: "blob:foto.png",
    });
    expect(queue.busy).toBe(true);
    await flush();
    expect(requestUpload).toHaveBeenCalledWith("c1", {
      filename: "foto.png",
      content_type: "image/png",
      size: 100,
    });
    expect(puts[0]?.headers).toEqual({ "Content-Type": "image/png" });
    puts[0]?.progress(40);
    expect(queue.getSnapshot()[0]?.progress).toBe(40);
    puts[0]?.resolve();
    await flush();
    expect(queue.getSnapshot()[0]).toMatchObject({
      status: "done",
      progress: 100,
      uploadId: "up1",
    });
    expect(queue.busy).toBe(false);
    expect(queue.ready).toBe(true);
    expect(queue.uploadIds()).toEqual(["up1"]);
  });

  it("valida no cliente: tipo, tamanho e o limite de 10 arquivos", () => {
    const { queue } = setup();
    const bad = new File(["x"], "a.svg", { type: "image/svg+xml" });
    const r1 = queue.add([bad]);
    expect(r1.rejected).toHaveLength(1);
    expect(queue.getSnapshot()).toHaveLength(0);

    queue.add(Array.from({ length: 10 }, (_, i) => png(`${i}.png`)));
    expect(queue.getSnapshot()).toHaveLength(10);
    const r2 = queue.add([png("11.png")]);
    expect(r2.rejected[0]).toMatch(/no máximo 10 arquivos/);
    expect(queue.getSnapshot()).toHaveLength(10);
  });

  it("limita os envios simultâneos e segue a fila", async () => {
    const { queue, puts, flush } = setup({ concurrency: 2 });
    queue.add([png("1.png"), png("2.png"), png("3.png")]);
    await flush();
    expect(puts).toHaveLength(2);
    puts[0]?.resolve();
    await flush();
    expect(puts).toHaveLength(3);
  });

  it("cancelar um envio em andamento aborta o XHR, some da lista e libera a miniatura", async () => {
    const { queue, puts, revoked, flush } = setup();
    queue.add([png("a.png")]);
    await flush();
    const id = queue.getSnapshot()[0]?.id as string;
    queue.remove(id);
    expect(puts[0]?.signal?.aborted).toBe(true);
    await flush();
    expect(queue.getSnapshot()).toHaveLength(0);
    expect(revoked).toEqual(["blob:a.png"]);
  });

  it("erro do servidor ao pedir o upload vira mensagem por arquivo; os outros seguem", async () => {
    const { queue, puts, requestUpload, flush } = setup();
    requestUpload.mockRejectedValueOnce(new ApiError(403, "sem permissão"));
    queue.add([png("a.png"), png("b.png")]);
    await flush();
    const [a, b] = queue.getSnapshot();
    expect(a).toMatchObject({
      status: "error",
      error: "Você não tem permissão para anexar arquivos neste canal.",
    });
    expect(b?.status).toBe("uploading");
    puts[0]?.resolve();
    await flush();
    expect(queue.hasError).toBe(true);
    expect(queue.uploadIds()).toEqual(["up1"]);
  });

  it.each([
    [422, "o arquivo passa do limite de 25 MB", "O arquivo passa do limite de 25 MB"],
    [409, "pendentes", "Há anexos demais aguardando. Envie a mensagem ou espere um pouco."],
    [503, "x", "O envio de arquivos está indisponível no momento."],
  ])("status %d vira texto em pt-br", async (status, detail, text) => {
    const { queue, requestUpload, flush } = setup();
    requestUpload.mockRejectedValueOnce(new ApiError(status, detail));
    queue.add([png()]);
    await flush();
    expect(queue.getSnapshot()[0]?.error).toBe(text);
  });

  it("429 informa o Retry-After", async () => {
    const { queue, requestUpload, flush } = setup();
    requestUpload.mockRejectedValueOnce(new ApiError(429, "x", [], 12));
    queue.add([png()]);
    await flush();
    expect(queue.getSnapshot()[0]?.error).toBe("Muitos envios seguidos. Tente de novo em 12 s.");
  });

  it("falha do PUT (storage) mostra o código; tentar de novo recomeça do zero", async () => {
    const { queue, puts, requestUpload, flush } = setup();
    queue.add([png()]);
    await flush();
    puts[0]?.reject(new UploadError("x", 403));
    await flush();
    expect(queue.getSnapshot()[0]).toMatchObject({
      status: "error",
      error: "O armazenamento recusou o arquivo (código 403).",
    });
    queue.retry(queue.getSnapshot()[0]?.id as string);
    expect(queue.getSnapshot()[0]).toMatchObject({ status: "uploading", progress: 0 });
    await flush();
    expect(requestUpload).toHaveBeenCalledTimes(2); // pede uma URL nova
    puts[1]?.resolve();
    await flush();
    expect(queue.getSnapshot()[0]?.status).toBe("done");
  });

  it("falha de rede no PUT tem mensagem própria", async () => {
    const { queue, puts, flush } = setup();
    queue.add([png()]);
    await flush();
    puts[0]?.reject(new UploadError("rede", 0));
    await flush();
    expect(queue.getSnapshot()[0]?.error).toBe("Falha de rede ao enviar o arquivo.");
  });

  it("os ids saem na ordem em que os arquivos foram adicionados", async () => {
    const { queue, puts, flush } = setup();
    queue.add([png("1.png"), png("2.png")]);
    await flush();
    puts[1]?.resolve(); // o segundo termina antes
    puts[0]?.resolve();
    await flush();
    expect(queue.uploadIds()).toEqual(["up1", "up2"]);
  });

  it("invalidateAll (mensagem recusada) devolve os prontos a 'erro' sem ids", async () => {
    const { queue, puts, flush } = setup();
    queue.add([png()]);
    await flush();
    puts[0]?.resolve();
    await flush();
    queue.invalidateAll("Envie de novo");
    expect(queue.getSnapshot()[0]).toMatchObject({ status: "error", error: "Envie de novo" });
    expect(queue.uploadIds()).toEqual([]);
  });

  it("clear aborta tudo, esvazia e libera as miniaturas; notifica quem assina", async () => {
    const { queue, puts, revoked, flush } = setup();
    const listener = vi.fn();
    queue.subscribe(listener);
    queue.add([png("a.png"), png("b.png")]);
    await flush();
    listener.mockClear();
    queue.clear();
    expect(puts.every((p) => p.signal?.aborted)).toBe(true);
    expect(queue.getSnapshot()).toHaveLength(0);
    expect(revoked).toHaveLength(2);
    expect(listener).toHaveBeenCalled();
  });
});
