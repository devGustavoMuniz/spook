// Risco de eco ao compartilhar áudio, inferido do NOME da saída de áudio escolhida. É só uma dica: o nome do
// dispositivo não prova nada (fone sem "headphone" no nome, caixa com "Bluetooth" no nome…), então a interface
// sempre mostra a orientação geral e usa isto apenas para reforçar o aviso.
import type { DeviceInfo } from "./engine";

const HEADPHONES =
  /\b(fones?|headphones?|headset|earbuds?|earphones?|airpods|buds|auriculares?|cascos?)\b/i;
const SPEAKERS =
  /\b(speakers?|alto[- ]?falantes?|caixas?(?: de som)?|monitor|hdmi|displayport|tv)\b/i;

/**
 * `true` = o nome sugere fone; `false` = sugere caixa de som/monitor/TV; `null` = não dá para saber (inclui a
 * saída "Padrão do sistema", cujo nome real o navegador não revela).
 */
export function outputLooksLikeHeadphones(
  outputs: readonly DeviceInfo[],
  chosenId: string | undefined,
): boolean | null {
  if (!chosenId) return null;
  const label = outputs.find((d) => d.id === chosenId)?.label;
  if (!label) return null;
  if (HEADPHONES.test(label)) return true;
  if (SPEAKERS.test(label)) return false;
  return null;
}
