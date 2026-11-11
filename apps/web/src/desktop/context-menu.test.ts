import { afterEach, describe, expect, it } from "vitest";
import { suppressNativeContextMenu } from "./context-menu";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  document.body.innerHTML = "";
  window.getSelection()?.removeAllRanges();
});

function rightClick(target: Element) {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
}

describe("menu de contexto nativo no desktop", () => {
  it("some em área vazia", () => {
    cleanups.push(suppressNativeContextMenu(document, false));
    document.body.innerHTML = "<div id='vazio'>nada</div>";
    expect(rightClick(document.getElementById("vazio") as Element).defaultPrevented).toBe(true);
  });

  it("fica em campos de texto (colar/copiar)", () => {
    cleanups.push(suppressNativeContextMenu(document, false));
    document.body.innerHTML =
      "<input id='i'><textarea id='t'></textarea><div id='c' contenteditable='true'></div>";
    for (const id of ["i", "t", "c"]) {
      expect(rightClick(document.getElementById(id) as Element).defaultPrevented).toBe(false);
    }
  });

  it("fica com texto selecionado", () => {
    cleanups.push(suppressNativeContextMenu(document, false));
    document.body.innerHTML = "<p id='p'>texto para copiar</p>";
    const p = document.getElementById("p") as Element;
    const range = document.createRange();
    range.selectNodeContents(p);
    window.getSelection()?.addRange(range);
    expect(rightClick(p).defaultPrevented).toBe(false);
  });

  it("não mexe em menu próprio que já tratou o evento", () => {
    cleanups.push(suppressNativeContextMenu(document, false));
    document.body.innerHTML = "<div id='x'></div>";
    const x = document.getElementById("x") as Element;
    x.addEventListener("contextmenu", (e) => e.preventDefault());
    expect(rightClick(x).defaultPrevented).toBe(true);
  });

  it("em desenvolvimento não instala nada", () => {
    cleanups.push(suppressNativeContextMenu(document, true));
    document.body.innerHTML = "<div id='vazio'></div>";
    expect(rightClick(document.getElementById("vazio") as Element).defaultPrevented).toBe(false);
  });
});
