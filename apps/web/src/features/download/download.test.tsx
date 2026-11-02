import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearReleaseCache, LATEST_RELEASE_URL } from "@/features/download/releases";
import { githubRelease } from "@/features/download/test-fixtures";
import { renderApp } from "@/test/render";
import { server } from "@/test/server";

function fakeNavigator(ua: string, platform: string, arch?: string) {
  vi.stubGlobal("navigator", {
    ...window.navigator,
    userAgent: ua,
    platform,
    userAgentData: arch
      ? { platform, mobile: false, getHighEntropyValues: async () => ({ architecture: arch }) }
      : undefined,
    clipboard: { writeText: vi.fn(async () => {}) },
  });
}

beforeEach(() => clearReleaseCache());
afterEach(() => vi.unstubAllGlobals());

const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";

describe("/download", () => {
  it("é pública e destaca o instalador do sistema detectado, com tamanho, versão e SHA-256", async () => {
    fakeNavigator(WIN_UA, "Win32");
    server.use(http.get(LATEST_RELEASE_URL, () => HttpResponse.json(githubRelease())));
    await renderApp("/download"); // sem sessão: não redireciona ao login
    const cta = await screen.findByRole("link", { name: /Baixar para Windows/ });
    expect(cta).toHaveAttribute("href", expect.stringMatching(/Spook-0\.2\.0-windows-x64\.exe$/));
    expect(screen.getByText(/Versão 0\.2\.0 · Instalador \(\.exe\) · 85,8 MB/)).toBeInTheDocument();

    // os quatro destinos aparecem
    for (const name of ["Windows", "macOS (Apple Silicon)", "macOS (Intel)", "Linux"]) {
      expect(
        screen.getByRole("heading", { name: new RegExp(`^${name.replace(/[()]/g, "\\$&")}`) }),
      ).toBeInTheDocument();
    }
    const win = screen
      .getByRole("heading", { name: /^Windows/ })
      .closest("div[aria-label='Windows']") as HTMLElement;
    expect(within(win).getByText("Recomendado")).toBeInTheDocument();
    expect(within(win).getByText("a".repeat(64))).toBeInTheDocument();
    // Linux oferece os dois formatos
    expect(screen.getByRole("link", { name: /AppImage/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\.deb/ })).toBeInTheDocument();
  });

  it("copia o SHA-256", async () => {
    fakeNavigator(WIN_UA, "Win32");
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    server.use(http.get(LATEST_RELEASE_URL, () => HttpResponse.json(githubRelease())));
    await renderApp("/download");
    await userEvent.click(
      await screen.findByRole("button", {
        name: "Copiar o SHA-256 de Spook-0.2.0-windows-x64.exe",
      }),
    );
    expect(writeText).toHaveBeenCalledWith("a".repeat(64));
  });

  it("no Mac recomenda Apple Silicon por padrão e Intel quando o navegador revela", async () => {
    fakeNavigator("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", "MacIntel");
    server.use(http.get(LATEST_RELEASE_URL, () => HttpResponse.json(githubRelease())));
    await renderApp("/download");
    expect(
      await screen.findByRole("link", { name: /Baixar para macOS \(Apple Silicon\)/ }),
    ).toBeInTheDocument();
  });

  it("no Mac Intel (arquitetura revelada) recomenda o .dmg Intel", async () => {
    fakeNavigator("Mozilla/5.0 (Macintosh)", "MacIntel", "x86");
    server.use(http.get(LATEST_RELEASE_URL, () => HttpResponse.json(githubRelease())));
    await renderApp("/download");
    expect(
      await screen.findByRole("link", { name: /Baixar para macOS \(Intel\)/ }),
    ).toHaveAttribute("href", expect.stringMatching(/macos-x64\.dmg$/));
  });

  it("no celular explica que o app é para computador", async () => {
    fakeNavigator("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)", "iPhone");
    server.use(http.get(LATEST_RELEASE_URL, () => HttpResponse.json(githubRelease())));
    await renderApp("/download");
    expect(await screen.findByText(/No celular, abra o Spook no navegador/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Baixar para/ })).not.toBeInTheDocument();
  });

  it("mostra as instruções de instalação com o aviso de app sem assinatura", async () => {
    fakeNavigator(WIN_UA, "Win32");
    server.use(http.get(LATEST_RELEASE_URL, () => HttpResponse.json(githubRelease())));
    await renderApp("/download");
    expect(await screen.findByText(/não tem assinatura de código/)).toBeInTheDocument();
    expect(screen.getByText(/Executar assim mesmo/)).toBeVisible();
    expect(screen.getByText(/Abrir mesmo assim/)).toBeInTheDocument();
    expect(screen.getByText(/chmod \+x/)).toBeInTheDocument();
  });

  it("ainda não há versão publicada: estado vazio", async () => {
    fakeNavigator(WIN_UA, "Win32");
    server.use(
      http.get(LATEST_RELEASE_URL, () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
    );
    await renderApp("/download");
    expect(
      await screen.findByRole("heading", { name: "Ainda não há versão publicada" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Todas as plataformas" })).not.toBeInTheDocument();
  });

  it("erro do GitHub: mensagem, tentar de novo e link dos releases", async () => {
    fakeNavigator(WIN_UA, "Win32");
    let fail = true;
    server.use(
      http.get(LATEST_RELEASE_URL, () =>
        fail ? HttpResponse.json({}, { status: 500 }) : HttpResponse.json(githubRelease()),
      ),
    );
    await renderApp("/download");
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Não foi possível carregar a versão",
    );
    expect(screen.getByRole("link", { name: /Releases no GitHub/ })).toHaveAttribute(
      "href",
      "https://github.com/devGustavoMuniz/spook/releases",
    );
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: /Tentar de novo/ }));
    expect(await screen.findByRole("link", { name: /Baixar para Windows/ })).toBeInTheDocument();
  });

  it("limite de requisições do GitHub tem mensagem própria", async () => {
    fakeNavigator(WIN_UA, "Win32");
    server.use(
      http.get(LATEST_RELEASE_URL, () =>
        HttpResponse.json({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
      ),
    );
    await renderApp("/download");
    expect(await screen.findByRole("alert")).toHaveTextContent("limitou as consultas");
  });
});

describe("links 'Baixar o app'", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  });

  it("aparece no login (web)", async () => {
    await renderApp("/login");
    expect(await screen.findByRole("link", { name: "Baixar o app" })).toHaveAttribute(
      "href",
      "/download",
    );
  });

  it("aparece nas configurações (web)", async () => {
    await renderApp("/settings/profile", { signedIn: true });
    expect((await screen.findAllByRole("link", { name: "Baixar o app" })).length).toBeGreaterThan(
      0,
    );
  });

  it("some no app desktop", async () => {
    Object.assign(window, { __TAURI_INTERNALS__: {} });
    await renderApp("/login");
    await screen.findByRole("heading", { name: "Entrar" });
    expect(screen.queryByRole("link", { name: "Baixar o app" })).not.toBeInTheDocument();
  });
});
