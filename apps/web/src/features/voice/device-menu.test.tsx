import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { FakeVoiceEngine } from "@/test/fake-voice-engine";
import { resetVoiceController } from "./controller";
import { DeviceMenu, LONG_PRESS_MS } from "./device-menu";
import { setVoiceEngineFactory } from "./engine-provider";

if (typeof window.PointerEvent === "undefined") {
  class PointerEventPolyfill extends MouseEvent {
    pointerType: string;
    constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "mouse";
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
}

let fake: FakeVoiceEngine;
const onClick = vi.fn();

function mount(kind: "audioinput" | "audiooutput" = "audioinput") {
  return render(
    <TooltipProvider>
      <DeviceMenu kind={kind}>
        <button type="button" onClick={onClick}>
          Silenciar
        </button>
      </DeviceMenu>
    </TooltipProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  onClick.mockClear();
  fake = new FakeVoiceEngine();
  fake.devices.audioinput = [
    { id: "mic1", label: "Microfone USB" },
    { id: "mic2", label: "Headset" },
  ];
  setVoiceEngineFactory(() => fake);
  resetVoiceController();
});
afterEach(() => {
  setVoiceEngineFactory(null);
  resetVoiceController();
  vi.useRealTimers();
});

describe("menu de dispositivos (setinha)", () => {
  it("a setinha é um botão com nome acessível, alcançável pelo teclado", async () => {
    const user = userEvent.setup();
    mount();
    const arrow = screen.getByRole("button", { name: "Escolher microfone" });
    await user.tab(); // botão principal
    await user.tab(); // setinha
    expect(arrow).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(await screen.findByRole("menu")).toBeInTheDocument();
  });

  it("lista Padrão + dispositivos, marca o salvo e troca a escolha", async () => {
    const user = userEvent.setup();
    localStorage.setItem("spook:voice-devices", JSON.stringify({ audioinput: "mic2" }));
    mount();
    await user.click(screen.getByRole("button", { name: "Escolher microfone" }));
    const menu = await screen.findByRole("menu");
    expect(await within(menu).findByRole("menuitemradio", { name: "Headset" })).toBeChecked();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Padrão do sistema" }),
    ).not.toBeChecked();
    await user.click(within(menu).getByRole("menuitemradio", { name: "Microfone USB" }));
    expect(fake.setDevices).toContainEqual(["audioinput", "mic1"]);
    expect(JSON.parse(localStorage.getItem("spook:voice-devices") ?? "{}").audioinput).toBe("mic1");
  });

  it("'Padrão do sistema' remove a preferência", async () => {
    const user = userEvent.setup();
    localStorage.setItem("spook:voice-devices", JSON.stringify({ audioinput: "mic2" }));
    mount();
    await user.click(screen.getByRole("button", { name: "Escolher microfone" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Padrão do sistema" }));
    expect(
      JSON.parse(localStorage.getItem("spook:voice-devices") ?? "{}").audioinput,
    ).toBeUndefined();
  });

  it("o fone mostra as saídas", async () => {
    const user = userEvent.setup();
    mount("audiooutput");
    await user.click(screen.getByRole("button", { name: "Escolher alto-falante" }));
    expect(await screen.findByRole("menuitemradio", { name: "Caixa de som" })).toBeInTheDocument();
  });

  it("sem dispositivos avisa", async () => {
    const user = userEvent.setup();
    fake.devices.audioinput = [];
    mount();
    await user.click(screen.getByRole("button", { name: "Escolher microfone" }));
    expect(await screen.findByText("Nenhum dispositivo encontrado")).toBeInTheDocument();
  });

  it("botão direito no botão principal abre o mesmo menu", async () => {
    mount();
    fireEvent.contextMenu(screen.getByRole("button", { name: "Silenciar" }));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    expect(onClick).not.toHaveBeenCalled();
  });

  it("toque longo abre o menu e o clique que sobra não aciona o botão", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    const main = screen.getByRole("button", { name: "Silenciar" });
    fireEvent.pointerDown(main, { pointerType: "touch" });
    await act(async () => void vi.advanceTimersByTime(LONG_PRESS_MS + 50));
    expect(await screen.findByRole("menu")).toBeInTheDocument();
    fireEvent.pointerUp(main, { pointerType: "touch" });
    fireEvent.click(main);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("toque curto continua sendo um clique normal", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mount();
    const main = screen.getByRole("button", { name: "Silenciar" });
    fireEvent.pointerDown(main, { pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.pointerUp(main, { pointerType: "touch" });
    fireEvent.click(main);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });
});
