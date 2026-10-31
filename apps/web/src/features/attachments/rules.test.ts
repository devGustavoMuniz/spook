import { describe, expect, it } from "vitest";
import { MAX_FILE_SIZE, resolveContentType, validateFile } from "./rules";

const f = (name: string, type: string, size = 1000) => ({ name, type, size });

describe("validateFile", () => {
  it.each([
    ["foto.png", "image/png"],
    ["foto.JPG", "image/jpeg"],
    ["foto.jpeg", "image/jpeg"],
    ["a.gif", "image/gif"],
    ["a.webp", "image/webp"],
    ["doc.pdf", "application/pdf"],
    ["nota.txt", "text/plain"],
    ["a.zip", "application/zip"],
    ["a.mp3", "audio/mpeg"],
    ["a.ogg", "audio/ogg"],
    ["a.webm", "audio/webm"],
    ["v.mp4", "video/mp4"],
    ["v.webm", "video/webm"],
  ])("aceita %s (%s)", (name, type) => {
    expect(validateFile(f(name, type))).toBeNull();
  });

  it("aceita exatamente 25 MB e recusa 1 byte a mais", () => {
    expect(validateFile(f("a.zip", "application/zip", MAX_FILE_SIZE))).toBeNull();
    expect(validateFile(f("a.zip", "application/zip", MAX_FILE_SIZE + 1))).toMatch(
      /passa do limite de 25 MB/,
    );
  });

  it("recusa arquivo vazio", () => {
    expect(validateFile(f("a.png", "image/png", 0))).toMatch(/está vazio/);
  });

  it.each([
    ["x.svg", "image/svg+xml"],
    ["x.html", "text/html"],
    ["x.exe", "application/x-msdownload"],
    ["x.js", "text/javascript"],
    ["x.bin", "application/octet-stream"],
  ])("recusa tipo proibido %s", (name, type) => {
    expect(validateFile(f(name, type))).toMatch(/tipo de arquivo não é permitido/);
  });

  it("recusa extensão que não combina com o tipo", () => {
    expect(validateFile(f("foto.txt", "image/png"))).toMatch(/extensão do nome não combina/);
    expect(validateFile(f("semextensao", "image/png"))).toMatch(/extensão do nome não combina/);
  });

  it("recusa nome longo demais", () => {
    expect(validateFile(f(`${"a".repeat(260)}.png`, "image/png"))).toMatch(/nome do arquivo/);
  });
});

describe("resolveContentType", () => {
  it("usa o tipo do navegador quando é permitido", () => {
    expect(resolveContentType(f("a.png", "IMAGE/PNG"))).toBe("image/png");
  });
  it("tipo vazio vem da extensão", () => {
    expect(resolveContentType(f("nota.md", ""))).toBe("text/plain");
    expect(resolveContentType(f("a.mp4", ""))).toBe("video/mp4");
    expect(resolveContentType(f("a.webm", ""))).toBe("video/webm");
  });
  it("text/csv e text/markdown valem como text/plain", () => {
    expect(resolveContentType(f("a.csv", "text/csv"))).toBe("text/plain");
    expect(validateFile(f("a.md", "text/markdown"))).toBeNull();
  });
  it("tipo proibido nunca é corrigido pela extensão", () => {
    expect(resolveContentType(f("a.txt", "image/svg+xml"))).toBe("image/svg+xml");
    expect(resolveContentType(f("a.html", "text/html"))).toBe("text/html");
  });
});
