export type Os = "windows" | "macos" | "linux";
export type Arch = "x64" | "arm64";

/** Pedaço do `navigator` que usamos (facilita testar). */
export type NavigatorLike = {
  userAgent?: string;
  platform?: string;
  userAgentData?: {
    platform?: string;
    mobile?: boolean;
    getHighEntropyValues?: (
      hints: string[],
    ) => Promise<{ architecture?: string; bitness?: string }>;
  };
};

export type Platform = { os: Os | null; mobile: boolean };

/** Sistema da pessoa: `userAgentData` (Chromium) primeiro, depois `platform` e `userAgent`. `os: null` = celular/desconhecido. */
export function detectPlatform(nav: NavigatorLike | undefined): Platform {
  if (!nav) return { os: null, mobile: false };
  const ua = nav.userAgent ?? "";
  const mobile = nav.userAgentData?.mobile ?? /android|iphone|ipad|ipod|mobile/i.test(ua);
  if (mobile) return { os: null, mobile: true };
  const hint = `${nav.userAgentData?.platform ?? ""} ${nav.platform ?? ""} ${ua}`.toLowerCase();
  if (/win/.test(hint) && !/darwin/.test(hint)) return { os: "windows", mobile: false };
  if (/mac|darwin/.test(hint)) return { os: "macos", mobile: false };
  if (/linux|x11|cros/.test(hint)) return { os: "linux", mobile: false };
  return { os: null, mobile: false };
}

/** Arquitetura quando o navegador revela (Chromium); `null` quando não dá para saber (Safari/Firefox no Mac). */
export async function detectArch(nav: NavigatorLike | undefined): Promise<Arch | null> {
  try {
    const v = await nav?.userAgentData?.getHighEntropyValues?.(["architecture"]);
    if (v?.architecture === "arm") return "arm64";
    if (v?.architecture === "x86") return "x64";
  } catch {
    // sem permissão ou sem suporte: segue sem palpite
  }
  return null;
}
