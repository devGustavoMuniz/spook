import type { ReactNode } from "react";

export function Notice({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
      <h1 className="text-lg font-semibold">{title}</h1>
      <div className="text-sm text-muted-foreground">{children}</div>
    </div>
  );
}
