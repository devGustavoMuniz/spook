import { Languages } from "lucide-react";
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { LOCALE_NAMES, LOCALES, type Locale, useT } from "@/i18n";

/** Submenu "Idioma" para o menu do usuário: troca o idioma da interface ao vivo (persistido no navegador). */
export function LanguageMenuItems() {
  const { t, locale, setLocale } = useT();
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Languages /> {t("shell.lang.label")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale)}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l} lang={l}>
              {LOCALE_NAMES[l]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
