import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { saveDevicePref, saveScreenSharePrefs } from "./devices";
import { setVoiceEngineFactory } from "./engine-provider";
import { ScreenShareDialog } from "./screen-share-dialog";

vi.mock("sonner", () => ({ toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() } }));

beforeEach(() => {
  localStorage.clear();
  setVoiceEngineFactory(() => new FakeVoiceEngine());
});
afterEach(() => {
  setVoiceEngineFactory(null);
  resetVoiceController();
});

describe("ScreenShareDialog", () => {
  it("o áudio começa desligado e a orientação sobre eco/aba/fones aparece", async () => {
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("switch", { name: /Incluir áudio/ })).not.toBeChecked();
    expect(screen.getByText(/ouvirão de volta \(eco\)/)).toBeInTheDocument();
    expect(screen.getByText(/compartilhe uma/)).toHaveTextContent(/aba/);
    expect(screen.getByText(/use fones de ouvido/)).toBeInTheDocument();
  });

  it("confirma sem áudio por padrão", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: false });
  });

  it("incluir áudio é uma escolha explícita", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={onConfirm} />);
    await user.click(await screen.findByRole("switch", { name: /Incluir áudio/ }));
    await user.click(screen.getByRole("button", { name: "Compartilhar" }));
    expect(onConfirm).toHaveBeenCalledWith({ audio: true });
  });

  it("lembra a última escolha", async () => {
    saveScreenSharePrefs({ audio: true });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    expect(await screen.findByRole("switch", { name: /Incluir áudio/ })).toBeChecked();
  });

  it("áudio ligado com saída que parece caixa de som: aviso extra de eco", async () => {
    const user = userEvent.setup();
    const eng = new FakeVoiceEngine();
    eng.devices.audiooutput = [{ id: "spk", label: "Alto-falantes (Realtek)" }];
    setVoiceEngineFactory(() => eng);
    saveDevicePref("audiooutput", "spk");
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const toggle = await screen.findByRole("switch", { name: /Incluir áudio/ });
    expect(screen.queryByRole("status")).toBeNull();
    await user.click(toggle);
    expect(await screen.findByRole("status")).toHaveTextContent(/caixa de som/);
  });

  it("com fones (ou saída desconhecida) não mostra o aviso extra", async () => {
    const eng = new FakeVoiceEngine();
    eng.devices.audiooutput = [{ id: "fone", label: "Fones de ouvido Bluetooth" }];
    setVoiceEngineFactory(() => eng);
    saveDevicePref("audiooutput", "fone");
    saveScreenSharePrefs({ audio: true });
    render(<ScreenShareDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    await screen.findByRole("switch", { name: /Incluir áudio/ });
    await waitFor(() => expect(screen.queryByRole("status")).toBeNull());
  });
});
