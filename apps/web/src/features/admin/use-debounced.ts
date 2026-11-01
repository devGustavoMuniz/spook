import { useEffect, useState } from "react";

/** Valor atrasado em `ms`: a busca só dispara a consulta quando a pessoa para de digitar. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
