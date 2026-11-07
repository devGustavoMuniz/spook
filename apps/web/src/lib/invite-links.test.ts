import { describe, expect, it } from "vitest";
import { extractInviteCodes } from "./invite-links";

const HOST = "spook.dev";

describe("extractInviteCodes", () => {
  it("acha links do próprio domínio, com http ou https, no meio do texto", () => {
    expect(extractInviteCodes("entra aí https://spook.dev/invite/abcd2345 valeu", HOST)).toEqual([
      "abcd2345",
    ]);
    expect(extractInviteCodes("http://spook.dev/invite/Xy9_-z12", HOST)).toEqual(["Xy9_-z12"]);
    expect(extractInviteCodes("(https://spook.dev/invite/abcd2345)", HOST)).toEqual(["abcd2345"]);
  });

  it("ignora outros domínios, subdomínios parecidos e links sem código", () => {
    expect(extractInviteCodes("https://outro.com/invite/abcd2345", HOST)).toEqual([]);
    expect(extractInviteCodes("https://spook.dev.evil.com/invite/abcd2345", HOST)).toEqual([]);
    expect(extractInviteCodes("https://xspook.dev/invite/abcd2345", HOST)).toEqual([]);
    expect(extractInviteCodes("https://spook.dev/invite/", HOST)).toEqual([]);
    expect(extractInviteCodes("https://spook.dev/invite/ab", HOST)).toEqual([]);
    expect(extractInviteCodes("sem link nenhum", HOST)).toEqual([]);
  });

  it("não repete o mesmo código e limita a dois cartões", () => {
    const t = [
      "https://spook.dev/invite/aaaa1111",
      "https://spook.dev/invite/aaaa1111",
      "https://spook.dev/invite/bbbb2222",
      "https://spook.dev/invite/cccc3333",
    ].join(" ");
    expect(extractInviteCodes(t, HOST)).toEqual(["aaaa1111", "bbbb2222"]);
  });

  it("por padrão usa o host da página", () => {
    expect(extractInviteCodes(`${window.location.origin}/invite/abcd2345 e mais`)).toEqual([
      "abcd2345",
    ]);
  });
});

describe("hosts do app desktop", () => {
  it("reconhece o domínio de produção mesmo quando a página é tauri.localhost", () => {
    const text =
      "entra aí https://spook.dottadigital.com/invite/AbCdEfGh e https://outro.site/invite/ZZZZZZZZ";
    expect(extractInviteCodes(text, ["tauri.localhost", "spook.dottadigital.com"])).toEqual([
      "AbCdEfGh",
    ]);
  });
});
