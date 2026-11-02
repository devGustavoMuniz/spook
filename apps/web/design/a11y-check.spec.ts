import { expect, type Page, test } from "@playwright/test";

// Verificação rápida de acessibilidade e teclado (fora do CI, como o capture.spec.ts; sem dependências novas).
//
//   E2E_BASE_URL=http://localhost:8097 pnpm --filter @spook/web exec playwright test -c design/playwright.config.ts design/a11y-check.spec.ts
//
// Pré-requisitos: os mesmos do capture (build servido pelo backend, LiveKit local para o palco de voz).
// Confere, por tema (claro/escuro):
//   1. foco visível: percorre com Tab as telas de login, canal, configurações e palco de voz e exige
//      outline ou box-shadow não nulo em cada elemento focado;
//   2. cursor: pointer computado em botões, links, switches, tabs e itens de menu;
//   3. prefers-reduced-motion: reduce sem animação/transição longa nos elementos visíveis.
// Os achados saem no console e em docs/design/a11y-check.txt quando A11Y_WRITE=1.

const PASSWORD = "senha-forte-123";
const run = Date.now().toString(36).slice(-4);
const report: string[] = [];
const problems: string[] = [];
const log = (s: string) => report.push(s);

type FocusInfo = { desc: string; outline: string; shadow: string; visible: boolean };

async function focusInfo(page: Page): Promise<FocusInfo | null> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const label = (
      el.getAttribute("aria-label") ||
      el.textContent ||
      el.getAttribute("placeholder") ||
      ""
    )
      .trim()
      .slice(0, 30);
    const outline =
      cs.outlineStyle !== "none" && Number.parseFloat(cs.outlineWidth) > 0
        ? `${cs.outlineWidth} ${cs.outlineStyle}`
        : "";
    let shadow = cs.boxShadow !== "none" ? cs.boxShadow : "";
    // Campos de texto dentro de um contêiner que mostra o anel com :focus-within (composer, campos com ícone).
    if (!outline && !shadow) {
      let p = el.parentElement;
      for (let i = 0; i < 3 && p && !shadow; i++, p = p.parentElement) {
        const pc = getComputedStyle(p);
        if (p.matches(":focus-within") && pc.boxShadow !== "none") shadow = `pai: ${pc.boxShadow}`;
      }
    }
    return {
      desc: `${el.tagName.toLowerCase()}${el.getAttribute("role") ? `[role=${el.getAttribute("role")}]` : ""} "${label}"`,
      outline,
      shadow,
      visible: r.width > 0 && r.height > 0,
    };
  });
}

async function tabThrough(page: Page, where: string, max = 40) {
  let checked = 0;
  const seen = new Set<string>();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const info = await focusInfo(page);
    if (!info || !info.visible) continue;
    const key = info.desc;
    if (seen.has(key)) continue;
    seen.add(key);
    checked++;
    // :focus-visible só aparece com teclado; o Tab garante isso.
    if (!info.outline && !info.shadow)
      problems.push(`[foco] ${where}: sem indicador em ${info.desc}`);
  }
  log(`foco ${where}: ${checked} elementos focáveis conferidos`);
  expect(checked, `${where} deve ter elementos focáveis`).toBeGreaterThan(0);
}

async function cursorCheck(page: Page, where: string) {
  const bad = await page.evaluate(() => {
    const sel =
      "button:not(:disabled), a[href], [role=button]:not([aria-disabled=true]), [role=tab], [role=switch], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=checkbox], [role=radio], summary";
    const out: string[] = [];
    let n = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      n++;
      const c = getComputedStyle(el).cursor;
      if (c !== "pointer") {
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 30);
        out.push(
          `${el.tagName.toLowerCase()}[${el.getAttribute("role") ?? ""}] "${label}" cursor=${c}`,
        );
      }
    }
    return { n, out: out.slice(0, 15), total: out.length };
  });
  log(`cursor ${where}: ${bad.n} clicáveis, ${bad.total} sem pointer`);
  for (const b of bad.out) problems.push(`[cursor] ${where}: ${b}`);
}

async function motionCheck(page: Page, where: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.waitForTimeout(300);
  const bad = await page.evaluate(() => {
    const out: string[] = [];
    let n = 0;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("body *"))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      n++;
      const cs = getComputedStyle(el);
      const anim = cs.animationName !== "none" && Number.parseFloat(cs.animationDuration) > 0.011;
      const infinite = cs.animationIterationCount === "infinite";
      const longTransition = cs.transitionDuration
        .split(",")
        .some((d) => Number.parseFloat(d) > 0.011);
      // O spinner (animate-spin) é a exceção documentada.
      const spinner = cs.animationName === "spin" || el.closest("[class*=animate-spin]");
      if ((anim || infinite) && !spinner)
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} anim=${cs.animationName} ${cs.animationDuration}`,
        );
      else if (longTransition && !spinner)
        out.push(
          `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 40)} transition=${cs.transitionDuration}`,
        );
    }
    return { n, out: out.slice(0, 15), total: out.length };
  });
  log(`movimento reduzido ${where}: ${bad.n} elementos, ${bad.total} com animação/transição`);
  for (const b of bad.out) problems.push(`[movimento] ${where}: ${b}`);
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

for (const theme of ["claro", "escuro"] as const) {
  test(`a11y ${theme}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem("spook-theme", t === "escuro" ? "dark" : "light");
      } catch {}
    }, theme);
    const page = await ctx.newPage();

    // Login (deslogado).
    await page.goto("/login");
    await page.waitForLoadState("networkidle");
    await tabThrough(page, `login/${theme}`);
    await cursorCheck(page, `login/${theme}`);
    await motionCheck(page, `login/${theme}`);

    // Conta e servidor pela API.
    const username = `a11y_${run}${theme === "escuro" ? "e" : "c"}`;
    const reg = await ctx.request.post("/api/auth/register", {
      data: { email: `${username}@spook.dev`, username, password: PASSWORD },
    });
    expect(reg.ok(), await reg.text()).toBeTruthy();
    const g = (await (
      await ctx.request.post("/api/guilds", { data: { name: "Acessibilidade" } })
    ).json()) as { id: string; channels: { id: string; type: number }[] };
    const text = g.channels.find((c) => c.type === 0)?.id ?? "";
    for (let i = 0; i < 3; i++)
      await ctx.request.post(`/api/channels/${text}/messages`, {
        data: { content: `mensagem ${i}` },
      });

    // Canal de texto.
    await page.goto(`/channels/${g.id}/${text}`);
    await page.getByRole("textbox").first().waitFor();
    await tabThrough(page, `canal/${theme}`, 50);
    await cursorCheck(page, `canal/${theme}`);
    await motionCheck(page, `canal/${theme}`);

    // Configurações.
    for (const route of ["/settings/profile", "/settings/appearance"]) {
      await page.goto(route);
      await page.waitForTimeout(500);
      await tabThrough(page, `${route}/${theme}`, 40);
      await cursorCheck(page, `${route}/${theme}`);
      await motionCheck(page, `${route}/${theme}`);
    }

    // Palco de voz.
    await page.goto(`/channels/${g.id}/${text}`);
    const voice = page
      .getByRole("navigation", { name: "Canais" })
      .getByRole("button", { name: /canal de voz/ })
      .first();
    await voice.waitFor({ timeout: 8_000 }).catch(() => undefined);
    if (await voice.isVisible().catch(() => false)) {
      await voice.click();
      const ok = await page
        .getByText("Voz conectada")
        .waitFor({ timeout: 25_000 })
        .then(() => true)
        .catch(() => false);
      if (ok) {
        await page.mouse.move(700, 450);
        await page.mouse.move(710, 460);
        const controls = page.getByRole("region", { name: "Controles de voz" });
        await controls.getByRole("button").first().focus();
        await tabThrough(page, `voz/${theme}`, 25);
        await cursorCheck(page, `voz/${theme}`);
        await motionCheck(page, `voz/${theme}`);
      } else {
        problems.push(`[voz] ${theme}: não conectou ao LiveKit; palco não verificado`);
      }
    } else {
      problems.push(`[voz] ${theme}: botão do canal de voz não encontrado`);
    }

    await ctx.close();
  });
}

test.afterAll(async () => {
  const out = [
    "# a11y-check",
    ...report,
    "",
    problems.length ? "## Problemas" : "## Nenhum problema",
    ...problems,
  ].join("\n");
  console.log(out);
  if (process.env.A11Y_WRITE) {
    const { writeFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    writeFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../../../docs/design/a11y-check.txt"),
      `${out}\n`,
    );
  }
});
