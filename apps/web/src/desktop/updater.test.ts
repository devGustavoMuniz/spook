import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createUpdater,
  type PendingUpdate,
  progressPercent,
  UPDATE_CHECK_INTERVAL_MS,
  type UpdaterBackend,
  updateErrorMessage,
} from "./updater";

function fakeUpdate(over: Partial<PendingUpdate> = {}): PendingUpdate & { calls: string[] } {
  const calls: string[] = [];
  return {
    version: "1.2.0",
    calls,
    download: async (onProgress) => {
      calls.push("download");
      onProgress(50, 200);
      onProgress(200, 200);
    },
    install: async () => {
      calls.push("install");
    },
    ...over,
  };
}

function setup(update: ReturnType<typeof fakeUpdate> | null, opts: { inCall?: boolean } = {}) {
  const log: string[] = [];
  const backend: UpdaterBackend = {
    check: vi.fn(async () => update),
    relaunch: vi.fn(async () => {
      log.push("relaunch");
    }),
    currentVersion: async () => "1.0.0",
  };
  const state = { inCall: opts.inCall ?? false };
  const u = createUpdater(backend, { now: () => 1000, inCall: () => state.inCall });
  return { u, backend, log, state };
}

describe("updateErrorMessage", () => {
  it("assinatura inválida", () => {
    expect(updateErrorMessage("signature verification failed", "download")).toMatch(/assinatura/);
  });
  it("sem internet", () => {
    expect(updateErrorMessage(new Error("error sending request for url"), "check")).toMatch(
      /Sem conexão/,
    );
    expect(updateErrorMessage("dns error: failed to lookup", "check")).toMatch(/Sem conexão/);
  });
  it("nada publicado", () => {
    expect(
      updateErrorMessage("Could not fetch a valid release JSON from the remote", "check"),
    ).toMatch(/nenhuma versão publicada/);
  });
  it("genéricos por fase", () => {
    expect(updateErrorMessage("boom", "check")).toMatch(/verificar/);
    expect(updateErrorMessage("boom", "download")).toMatch(/baixar/);
    expect(updateErrorMessage("boom", "install")).toMatch(/instalar.*página de download/);
    expect(updateErrorMessage(undefined, "check")).toMatch(/verificar/);
  });
});

describe("progressPercent", () => {
  it("calcula, limita e aceita total desconhecido", () => {
    expect(progressPercent(50, 200)).toBe(25);
    expect(progressPercent(300, 200)).toBe(100);
    expect(progressPercent(10)).toBeNull();
    expect(progressPercent(10, 0)).toBeNull();
  });
});

describe("controlador de atualização", () => {
  it("sem versão nova: em dia", async () => {
    const { u } = setup(null);
    await u.check();
    expect(u.getStatus()).toEqual({ kind: "uptodate", checkedAt: 1000 });
  });

  it("achou: baixa sozinho em segundo plano e fica pronto, sem instalar", async () => {
    const update = fakeUpdate();
    const { u } = setup(update);
    const seen: string[] = [];
    u.useStore.subscribe((s) => seen.push(s.status.kind));
    await u.check();
    expect(seen).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloading",
      "ready",
    ]);
    expect(u.getStatus()).toEqual({ kind: "ready", version: "1.2.0" });
    expect(update.calls).toEqual(["download"]);
  });

  it("guarda o progresso (bytes e total)", async () => {
    let seen: unknown;
    const update = fakeUpdate({
      download: async (onProgress) => {
        onProgress(40, 100);
        seen = u.getStatus();
      },
    });
    const { u } = setup(update);
    await u.check();
    expect(seen).toEqual({ kind: "downloading", version: "1.2.0", downloaded: 40, total: 100 });
  });

  it("erro na verificação automática é silencioso; na manual aparece", async () => {
    const { u, backend } = setup(null);
    vi.mocked(backend.check).mockRejectedValue("error sending request");
    await u.check();
    expect(u.getStatus()).toEqual({ kind: "idle" });
    await u.check({ manual: true });
    expect(u.getStatus()).toMatchObject({ kind: "error", phase: "check" });
    expect((u.getStatus() as { message: string }).message).toMatch(/Sem conexão/);
  });

  it("falha no download (assinatura): erro e 'tentar de novo' baixa de novo", async () => {
    let fail = true;
    const update = fakeUpdate({
      download: async () => {
        if (fail) throw new Error("signature mismatch");
      },
    });
    const { u } = setup(update);
    await u.check();
    expect(u.getStatus()).toMatchObject({ kind: "error", phase: "download", version: "1.2.0" });
    fail = false;
    await u.download();
    expect(u.getStatus()).toEqual({ kind: "ready", version: "1.2.0" });
  });

  it("não verifica de novo enquanto baixa ou já está pronto", async () => {
    const { u, backend } = setup(fakeUpdate());
    await u.check();
    await u.check();
    expect(backend.check).toHaveBeenCalledTimes(1);
  });

  it("reiniciar fora de chamada instala e reinicia, nessa ordem", async () => {
    const update = fakeUpdate();
    const { u, backend, log } = setup(update);
    update.install = async () => {
      log.push("install");
    };
    await u.check();
    await u.requestRestart();
    expect(log).toEqual(["install", "relaunch"]);
    expect(backend.relaunch).toHaveBeenCalledTimes(1);
  });

  it("em chamada de voz pede confirmação e só reinicia ao confirmar", async () => {
    const update = fakeUpdate();
    const { u, backend, state } = setup(update, { inCall: true });
    await u.check();
    await u.requestRestart();
    expect(u.useStore.getState().confirmRestart).toBe(true);
    expect(update.calls).not.toContain("install");
    expect(backend.relaunch).not.toHaveBeenCalled();

    u.dismissRestart();
    expect(u.useStore.getState().confirmRestart).toBe(false);
    expect(backend.relaunch).not.toHaveBeenCalled();

    await u.requestRestart();
    state.inCall = false;
    await u.confirmRestartNow();
    expect(update.calls).toContain("install");
    expect(backend.relaunch).toHaveBeenCalledTimes(1);
  });

  it("reiniciar sem nada baixado não faz nada", async () => {
    const { u, backend } = setup(null);
    await u.requestRestart();
    expect(backend.relaunch).not.toHaveBeenCalled();
  });

  it("falha ao instalar vira erro de instalação", async () => {
    const update = fakeUpdate({
      install: async () => {
        throw new Error("permission denied");
      },
    });
    const { u, backend } = setup(update);
    await u.check();
    await u.requestRestart();
    expect(u.getStatus()).toMatchObject({ kind: "error", phase: "install" });
    expect(backend.relaunch).not.toHaveBeenCalled();
  });
});

describe("verificação periódica", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("verifica a cada 6 horas e para quando pedido", async () => {
    const { u, backend } = setup(null);
    const stop = u.startPeriodicChecks();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS - 1);
    expect(backend.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(backend.check).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
    expect(backend.check).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS * 2);
    expect(backend.check).toHaveBeenCalledTimes(2);
  });
});
