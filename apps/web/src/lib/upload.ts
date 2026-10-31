/** Falha do PUT no storage: `status` 0 = rede. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/** Envio cancelado pelo usuário (AbortSignal ou `xhr.abort()`). */
export class UploadAbortError extends Error {
  constructor() {
    super("Envio cancelado");
    this.name = "AbortError";
  }
}

export type PutOptions = {
  /** Cabeçalhos exatos que a URL pré-assinada exige (hoje só `Content-Type`). */
  headers?: Record<string, string>;
  signal?: AbortSignal;
};

/**
 * PUT direto no storage (URL pré-assinada) via XMLHttpRequest, o único jeito de ter progresso de
 * upload (SPEC 5). Content-Type e tamanho precisam ser exatamente os assinados.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  opts: PutOptions = {},
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new UploadAbortError());
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    const headers = opts.headers ?? { "Content-Type": file.type };
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => opts.signal?.removeEventListener("abort", onAbort);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new UploadError(`Falha no envio (${xhr.status})`, xhr.status));
      }
    };
    xhr.onerror = () => {
      done();
      reject(new UploadError("Falha de rede no envio", 0));
    };
    xhr.onabort = () => {
      done();
      reject(new UploadAbortError());
    };
    xhr.send(file);
  });
}
