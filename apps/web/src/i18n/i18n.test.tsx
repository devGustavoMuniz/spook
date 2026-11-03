import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { formatMessageTime, formatRelative } from "@/lib/format";
import {
  __setCatalogForTest,
  catalogs,
  detectLocale,
  matchLocale,
  setLocale,
  t,
  useT,
} from "./core";
import { formatBadge, formatNumber } from "./format";
import { en } from "./messages/en";
import { ptBR } from "./messages/pt-BR";
import { I18nProvider } from "./provider";

afterEach(() => {
  __setCatalogForTest("en", en);
  __setCatalogForTest("pt-BR", ptBR);
});

describe("t()", () => {
  it("interpola {nome} e deixa o placeholder se faltar o parâmetro", () => {
    __setCatalogForTest("pt-BR", { ...ptBR, "x.hi": "Olá, {nome}! {nome}{x}" } as never);
    expect(t("x.hi" as never, { nome: "Ana" })).toBe("Olá, Ana! Ana{x}");
  });

  it("escolhe a forma de plural pelo idioma", () => {
    const msg = { one: "{count} pessoa", other: "{count} pessoas" };
    __setCatalogForTest("pt-BR", { ...ptBR, "x.n": msg } as never);
    __setCatalogForTest("en", {
      ...en,
      "x.n": { one: "{count} person", other: "{count} people" },
    } as never);
    expect(t("x.n" as never, { count: 1 })).toBe("1 pessoa");
    expect(t("x.n" as never, { count: 2 })).toBe("2 pessoas");
    setLocale("en", { persist: false });
    expect(t("x.n" as never, { count: 1 })).toBe("1 person");
    expect(t("x.n" as never, { count: 5 })).toBe("5 people");
  });

  it("usa `zero` quando existe e count é 0", () => {
    __setCatalogForTest("pt-BR", {
      ...ptBR,
      "x.z": { zero: "ninguém", one: "um", other: "{count}" },
    } as never);
    expect(t("x.z" as never, { count: 0 })).toBe("ninguém");
  });

  it("cai para pt-BR quando falta a chave no idioma ativo e para a chave se não existir em lugar nenhum", () => {
    __setCatalogForTest("pt-BR", { ...ptBR, "x.only": "só em português" } as never);
    setLocale("en", { persist: false });
    expect(t("x.only" as never)).toBe("só em português");
    expect(t("x.nada" as never)).toBe("x.nada");
  });
});

describe("idioma ao vivo", () => {
  function Probe() {
    const { t, locale, setLocale } = useT();
    return (
      <button type="button" onClick={() => setLocale("en")}>
        {locale}:{t("format.relative.now")}
      </button>
    );
  }

  it("troca sem recarregar, atualiza <html lang> e persiste", () => {
    render(
      <I18nProvider>
        <Probe />
      </I18nProvider>,
    );
    expect(screen.getByRole("button")).toHaveTextContent("pt-BR:agora");
    expect(document.documentElement.lang).toBe("pt-BR");
    act(() => screen.getByRole("button").click());
    expect(screen.getByRole("button")).toHaveTextContent("en:just now");
    expect(document.documentElement.lang).toBe("en");
    expect(localStorage.getItem("spook-locale")).toBe("en");
    expect(detectLocale()).toBe("en");
  });
});

describe("detecção", () => {
  it("normaliza tags de idioma", () => {
    expect(matchLocale("pt")).toBe("pt-BR");
    expect(matchLocale("pt-PT")).toBe("pt-BR");
    expect(matchLocale("en-GB")).toBe("en");
    expect(matchLocale("fr")).toBeNull();
  });

  it("localStorage vence o navegador e o padrão é pt-BR", () => {
    expect(detectLocale()).toBe("pt-BR");
    localStorage.setItem("spook-locale", "en");
    expect(detectLocale()).toBe("en");
  });
});

describe("formatação", () => {
  it("datas e relativos acompanham o idioma", () => {
    const now = new Date("2026-11-03T12:00:00");
    const iso = new Date(now.getTime() - 3 * 3600_000).toISOString();
    expect(formatRelative(iso, now)).toBe("há 3 h");
    expect(formatMessageTime(new Date().toISOString())).toMatch(/^Hoje às \d{2}:\d{2}$/);
    setLocale("en", { persist: false });
    expect(formatRelative(iso, now)).toBe("3 h ago");
    expect(formatMessageTime(new Date().toISOString())).toMatch(/^Today at \d{1,2}:\d{2} (AM|PM)$/);
  });

  it("números e contador", () => {
    expect(formatNumber(1234.5)).toBe("1.234,5");
    setLocale("en", { persist: false });
    expect(formatNumber(1234.5)).toBe("1,234.5");
    expect(formatBadge(100)).toBe("99+");
    expect(formatBadge(7)).toBe("7");
  });
});

describe("catálogos", () => {
  it("os dois idiomas existem", () => {
    expect(Object.keys(catalogs)).toEqual(["pt-BR", "en"]);
  });
});
