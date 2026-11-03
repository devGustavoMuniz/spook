import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { Input } from "@/components/ui/input";
import { useT } from "@/i18n";

/** Campo de senha com botão de mostrar/ocultar (acessível: `aria-pressed` e rótulo que muda). */
export function PasswordInput({ ref, ...props }: Omit<React.ComponentProps<typeof Input>, "type">) {
  const { t } = useT();
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <Input ref={ref} type={shown ? "text" : "password"} className="pr-10" {...props} />
      <button
        type="button"
        onClick={() => setShown((v) => !v)}
        aria-pressed={shown}
        aria-label={shown ? t("auth.password.hide") : t("auth.password.show")}
        title={shown ? t("auth.password.hide") : t("auth.password.show")}
        className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-md text-muted-foreground hover:text-foreground"
      >
        {shown ? (
          <EyeOff className="size-4" aria-hidden="true" />
        ) : (
          <Eye className="size-4" aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
