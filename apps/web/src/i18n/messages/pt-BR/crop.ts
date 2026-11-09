import type { MessageMap } from "../../types";

export const crop = {
  "crop.animatedAsIs":
    "Esta imagem é animada (WebP ou PNG animado) e não pode ser recortada sem perder a animação. Ela será usada inteira, centralizada na exibição.",
  "crop.apply": "Aplicar",
  "crop.description": "Arraste para posicionar e use o zoom para escolher a área que será exibida.",
  "crop.failed": "Não foi possível recortar a imagem. Tente outra.",
  "crop.frameLabel": "Área de recorte: arraste a imagem para posicioná-la",
  "crop.gifFallback":
    "Este GIF é grande ou complexo demais para recortar. Usamos o arquivo original, centralizado.",
  "crop.gifNote":
    "GIF animado: o recorte vale para todos os quadros e preserva a animação, sem redimensionar.",
  "crop.keys": "Setas movem a imagem (Shift move mais), + e - mudam o zoom, Esc cancela.",
  "crop.loadFailed": "Não foi possível abrir esta imagem.",
  "crop.preview": "Pré-visualização",
  "crop.reset": "Redefinir enquadramento",
  "crop.title.avatar": "Ajustar avatar",
  "crop.title.banner": "Ajustar banner",
  "crop.title.icon": "Ajustar ícone do servidor",
  "crop.zoom": "Zoom",
} as const satisfies MessageMap;
