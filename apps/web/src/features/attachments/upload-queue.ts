import { isApiError, type UploadBody, type UploadPayload } from "@spook/shared";
import { t } from "@/i18n";
import { formatBytes } from "@/lib/file-size";
import { type PutOptions, UploadAbortError, UploadError } from "@/lib/upload";
import { MAX_ATTACHMENTS, resolveContentType, validateFile } from "./rules";

export type PendingStatus = "uploading" | "done" | "error";

export type PendingFile = {
  /** Id local (não é o id do anexo no servidor). */
  id: string;
  file: File;
  name: string;
  size: number;
  contentType: string;
  /** Miniatura local (object URL) das imagens. */
  previewUrl?: string;
  status: PendingStatus;
  /** 0 a 100. */
  progress: number;
  /** Id do upload no servidor, depois de pedido. */
  uploadId?: string;
  error?: string;
};

export type QueueDeps = {
  requestUpload: (channelId: string, body: UploadBody) => Promise<UploadPayload>;
  put: (
    url: string,
    file: File,
    onProgress: (percent: number) => void,
    opts?: PutOptions,
  ) => Promise<void>;
  createPreviewUrl?: (file: File) => string;
  revokePreviewUrl?: (url: string) => void;
  /** Uploads simultâneos (o servidor limita 30 pedidos por minuto e 30 pendentes). */
  concurrency?: number;
};

export type AddResult = {
  /** Avisos em pt-br dos arquivos recusados no cliente (e dos que passaram do limite de 10). */
  rejected: string[];
};

/** Mensagem em pt-br para uma falha ao pedir o upload ou ao enviá-lo ao storage. */
export function uploadErrorMessage(e: unknown): string {
  if (e instanceof UploadError)
    return e.status === 0
      ? t("chat.upload.networkFail")
      : t("chat.upload.storageRefused", { status: e.status });
  if (!isApiError(e)) return t("chat.upload.generic");
  switch (e.status) {
    case 403:
      return t("chat.upload.forbidden");
    case 404:
      return t("chat.upload.channelGone");
    case 409:
      return t("chat.upload.tooManyPending");
    case 422:
      return e.detail
        ? e.detail.charAt(0).toUpperCase() + e.detail.slice(1)
        : t("chat.upload.invalidFile");
    case 429:
      return e.retryAfter
        ? t("chat.upload.rateLimitedIn", { seconds: e.retryAfter })
        : t("chat.upload.rateLimited");
    case 503:
      return t("chat.upload.unavailable");
    default:
      return e.status >= 500 ? t("chat.upload.serverError") : e.detail;
  }
}

/**
 * Fila de anexos pendentes de um composer: valida, pede a URL pré-assinada, envia o arquivo por
 * XHR com progresso e guarda o id de cada upload para o `POST /messages`. Sem React: a tela assina
 * com `subscribe`/`getSnapshot` (useSyncExternalStore).
 */
export class UploadQueue {
  private items: PendingFile[] = [];
  private listeners = new Set<() => void>();
  private aborts = new Map<string, AbortController>();
  private waiting: string[] = [];
  private running = 0;
  private seq = 0;

  constructor(
    private readonly channelId: string,
    private readonly deps: QueueDeps,
  ) {}

  getSnapshot = (): readonly PendingFile[] => this.items;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };

  /** Há arquivo ainda sendo enviado. */
  get busy() {
    return this.items.some((i) => i.status === "uploading");
  }
  get hasError() {
    return this.items.some((i) => i.status === "error");
  }
  /** Todos prontos (e há pelo menos um). */
  get ready() {
    return this.items.length > 0 && this.items.every((i) => i.status === "done");
  }

  /** Ids dos uploads concluídos, na ordem em que foram adicionados. */
  uploadIds(): string[] {
    return this.items.flatMap((i) => (i.status === "done" && i.uploadId ? [i.uploadId] : []));
  }

  add(files: File[]): AddResult {
    const rejected: string[] = [];
    for (const file of files) {
      if (this.items.length >= MAX_ATTACHMENTS) {
        rejected.push(t("chat.upload.maxFiles", { max: MAX_ATTACHMENTS }));
        break;
      }
      const problem = validateFile(file);
      if (problem) {
        rejected.push(problem);
        continue;
      }
      const id = `p${++this.seq}`;
      const isImage = file.type.startsWith("image/");
      this.items = [
        ...this.items,
        {
          id,
          file,
          name: file.name,
          size: file.size,
          contentType: resolveContentType(file),
          previewUrl: isImage ? this.deps.createPreviewUrl?.(file) : undefined,
          status: "uploading",
          progress: 0,
        },
      ];
      this.waiting.push(id);
    }
    this.emit();
    this.pump();
    return { rejected };
  }

  /** Remove o arquivo (cancela o envio, se estiver em andamento). */
  remove(id: string) {
    const item = this.find(id);
    if (!item) return;
    this.aborts.get(id)?.abort();
    this.waiting = this.waiting.filter((w) => w !== id);
    this.release(item);
    this.items = this.items.filter((i) => i.id !== id);
    this.emit();
  }

  /** Tenta de novo um arquivo que falhou. */
  retry(id: string) {
    const item = this.find(id);
    if (!item || item.status !== "error") return;
    this.patch(id, { status: "uploading", progress: 0, error: undefined, uploadId: undefined });
    this.waiting.push(id);
    this.pump();
  }

  /**
   * O servidor recusou os anexos ao enviar a mensagem (apagou ou não achou o objeto): os ids não
   * valem mais, então todos voltam a "erro" e "tentar de novo" pede uploads novos.
   */
  invalidateAll(message: string) {
    this.items = this.items.map((i) =>
      i.status === "done" ? { ...i, status: "error", error: message, uploadId: undefined } : i,
    );
    this.emit();
  }

  /** Esvazia a fila (mensagem enviada ou composer descartado). */
  clear() {
    for (const c of this.aborts.values()) c.abort();
    for (const i of this.items) this.release(i);
    this.items = [];
    this.waiting = [];
    this.emit();
  }

  // ---- interno ----

  private find(id: string) {
    return this.items.find((i) => i.id === id);
  }

  private release(item: PendingFile) {
    if (item.previewUrl) this.deps.revokePreviewUrl?.(item.previewUrl);
  }

  private patch(id: string, change: Partial<PendingFile>) {
    this.items = this.items.map((i) => (i.id === id ? { ...i, ...change } : i));
    this.emit();
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  private pump() {
    const limit = this.deps.concurrency ?? 3;
    while (this.running < limit && this.waiting.length > 0) {
      const id = this.waiting.shift() as string;
      this.running++;
      void this.run(id).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async run(id: string) {
    const item = this.find(id);
    if (!item) return;
    const ctl = new AbortController();
    this.aborts.set(id, ctl);
    try {
      const payload = await this.deps.requestUpload(this.channelId, {
        filename: item.name,
        content_type: item.contentType,
        size: item.size,
      });
      if (ctl.signal.aborted) return;
      this.patch(id, { uploadId: payload.id });
      await this.deps.put(
        payload.upload_url,
        item.file,
        (p) => this.find(id) && this.patch(id, { progress: p }),
        { headers: payload.headers, signal: ctl.signal },
      );
      if (this.find(id)) this.patch(id, { status: "done", progress: 100 });
    } catch (e) {
      // Removido pelo usuário: nada a mostrar.
      if (ctl.signal.aborted || e instanceof UploadAbortError || !this.find(id)) return;
      this.patch(id, { status: "error", error: uploadErrorMessage(e) });
    } finally {
      this.aborts.delete(id);
    }
  }
}

/** Texto curto do arquivo para listas e leitores de tela: "foto.png (1,5 MB)". */
export const describePending = (p: Pick<PendingFile, "name" | "size">) =>
  `${p.name} (${formatBytes(p.size)})`;
