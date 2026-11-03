import { AtSign, Users } from "lucide-react";
import { useEffect, useRef } from "react";
import { Avatar } from "@/components/avatar";
import { useT } from "@/i18n";
import type { MentionOption } from "@/lib/mentions";
import { cn } from "@/lib/utils";

/** Id do `listbox` e de cada opção, para o `aria-controls`/`aria-activedescendant` do campo. */
export const mentionListId = (composerId: string) => `${composerId}-mentions`;
export const mentionOptionId = (composerId: string, i: number) => `${composerId}-mention-${i}`;

/**
 * Lista de sugestões de menção (`role="listbox"`). Quem controla o foco é o campo de texto (combobox): a lista
 * só mostra e recebe o clique; setas, Enter, Tab e Esc ficam no campo. Ancorada acima do compositor.
 */
export function MentionSuggestions({
  id,
  options,
  active,
  onPick,
  onHover,
}: {
  id: string;
  options: MentionOption[];
  active: number;
  onPick: (o: MentionOption) => void;
  onHover: (i: number) => void;
}) {
  const { t } = useT();
  const activeEl = useRef<HTMLLIElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: acompanha a opção ativa
  useEffect(() => {
    activeEl.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <div className="absolute right-0 bottom-full left-0 z-30 mb-2 px-3 sm:px-4">
      <div className="overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
        <p className="border-b border-border px-3 py-1.5 text-xs font-medium text-muted-foreground">
          {t("chat.mentions.title")}
        </p>
        <ul
          id={mentionListId(id)}
          // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: padrão combobox/listbox do campo
          role="listbox"
          aria-label={t("chat.mentions.suggestions")}
          className="max-h-60 overflow-y-auto p-1"
        >
          {options.map((o, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: o teclado é do campo (setas, Enter, Tab)
            <li
              key={o.id}
              ref={i === active ? activeEl : undefined}
              id={mentionOptionId(id, i)}
              // biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: opção do listbox do combobox
              role="option"
              aria-selected={i === active}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(o)}
              onMouseMove={() => i !== active && onHover(i)}
              className={cn(
                "flex min-h-11 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm sm:min-h-9",
                i === active ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
              )}
            >
              {o.kind === "user" ? (
                <Avatar url={o.avatarUrl} name={o.label} size={24} />
              ) : (
                <span
                  className="flex size-6 items-center justify-center rounded-full bg-secondary"
                  data-mention-kind={o.kind}
                >
                  {o.kind === "everyone" ? (
                    <Users className="size-3.5" />
                  ) : (
                    <AtSign
                      className="size-3.5"
                      style={o.color ? { color: o.color } : undefined}
                      aria-hidden
                    />
                  )}
                </span>
              )}
              <span className="min-w-0 flex-1 truncate font-medium">
                {o.kind === "everyone" ? `@${o.label}` : o.label}
              </span>
              {o.hintKey ? (
                <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
                  {t(o.hintKey)}
                </span>
              ) : o.label !== o.handle ? (
                <span className="shrink-0 text-xs text-muted-foreground">@{o.handle}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
