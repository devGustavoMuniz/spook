import { Accessibility, Moon, Palette, Sun } from "lucide-react";
import { useMediaQuery } from "@/components/shell";
import { type Theme, useTheme } from "@/components/theme-provider";
import { SettingsGroup } from "@/features/settings/ui";
import { cn } from "@/lib/utils";

// A prévia mostra o tema ESCOLHIDO, não o atual: por isso usa as cores de packages/brand/tokens.css
// como valores literais (as variáveis CSS do documento seguem o tema ativo).
const PALETTE = {
  light: {
    bg: "#fbfafe",
    rail: "#f4f1fa",
    card: "#ffffff",
    line: "#ece7f7",
    text: "#17132a",
    brand: "#7c5cc4",
  },
  dark: {
    bg: "#0a0912",
    rail: "#100e1a",
    card: "#161325",
    line: "#1f1b33",
    text: "#f4f2fa",
    brand: "#7c5cc4",
  },
} as const;

const OPTIONS: { value: Theme; label: string; hint: string }[] = [
  { value: "light", label: "Claro", hint: "Fundo claro, ideal com bastante luz." },
  { value: "dark", label: "Escuro", hint: "Fundo escuro, mais confortável à noite." },
  { value: "system", label: "Sistema", hint: "Acompanha o tema do seu dispositivo." },
];

function Half({ mode }: { mode: "light" | "dark" }) {
  const c = PALETTE[mode];
  return (
    <div className="flex h-full w-full" style={{ background: c.bg }}>
      <div className="flex w-1/4 flex-col gap-1 p-1.5" style={{ background: c.rail }}>
        <span className="size-2.5 rounded-full" style={{ background: c.brand }} />
        <span className="h-1 w-full rounded-full" style={{ background: c.line }} />
        <span className="h-1 w-3/4 rounded-full" style={{ background: c.line }} />
      </div>
      <div className="flex flex-1 flex-col justify-end gap-1.5 p-2">
        <span className="h-2 w-2/3 rounded-md" style={{ background: c.card }} />
        <span className="h-2 w-1/2 self-end rounded-md" style={{ background: c.brand }} />
        <span className="h-3 w-full rounded-md" style={{ background: c.line }} />
      </div>
    </div>
  );
}

function Preview({ value }: { value: Theme }) {
  return (
    <span
      aria-hidden
      className="relative block h-24 w-full overflow-hidden rounded-md border border-border"
    >
      {value === "system" ? (
        <>
          <span className="absolute inset-0">
            <Half mode="light" />
          </span>
          <span
            className="absolute inset-0"
            style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
          >
            <Half mode="dark" />
          </span>
        </>
      ) : (
        <Half mode={value} />
      )}
    </span>
  );
}

const ICON = { light: Sun, dark: Moon, system: Palette } as const;

/** `/settings/appearance`: tema claro, escuro ou do sistema. */
export function AppearancePage() {
  const { theme, setTheme, resolved } = useTheme();
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  return (
    <div className="flex flex-col gap-6">
      <SettingsGroup
        icon={Palette}
        title="Tema"
        description="A escolha fica salva neste navegador ou app."
      >
        <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <legend className="sr-only">Tema do app</legend>
          {OPTIONS.map(({ value, label, hint }) => {
            const Icon = ICON[value];
            const id = `theme-${value}`;
            return (
              <label
                key={value}
                htmlFor={id}
                className={cn(
                  "flex cursor-pointer flex-col gap-2.5 rounded-xl border bg-surface-1 p-2.5 transition-colors hover:border-brand-400 has-[:checked]:border-primary has-[:checked]:bg-accent has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring",
                )}
              >
                <input
                  id={id}
                  type="radio"
                  name="theme"
                  value={value}
                  className="sr-only"
                  checked={theme === value}
                  aria-describedby={`${id}-hint`}
                  onChange={() => setTheme(value)}
                />
                <Preview value={value} />
                <span className="flex items-center gap-2 px-0.5 text-sm font-medium">
                  <Icon className="size-4 text-muted-foreground" aria-hidden />
                  {label}
                </span>
                <span id={`${id}-hint`} className="px-0.5 text-xs text-muted-foreground">
                  {hint}
                </span>
              </label>
            );
          })}
        </fieldset>
        <p className="text-xs text-muted-foreground" aria-live="polite">
          Tema em uso agora: {resolved === "dark" ? "escuro" : "claro"}.
        </p>
      </SettingsGroup>
      <SettingsGroup
        icon={Accessibility}
        title="Movimento"
        description="O Spook segue a preferência de movimento reduzido do seu sistema: não há chave aqui para isso."
      >
        <p className="rounded-lg bg-surface-1 px-3 py-2.5 text-sm">
          {reduced
            ? "Movimento reduzido está ligado no seu sistema: as animações do app ficam mínimas."
            : "Movimento reduzido está desligado no seu sistema. Para reduzir as animações, ligue essa opção nas configurações de acessibilidade do sistema."}
        </p>
      </SettingsGroup>
    </div>
  );
}
