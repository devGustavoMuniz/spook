import type { MessageMap } from "../../types";

// Nitro e Nitro+ (planos opcionais): seção em Configurações, selos, cadeados e avisos.
export const nitro = {
  "settings.sections.nitro.label": "Nitro",
  "settings.sections.nitro.description":
    "Veja seu plano, resgate um código e compare o que cada plano libera.",
  "nitro.tier.free": "Grátis",
  "nitro.tier.nitro": "Nitro",
  "nitro.tier.nitro_plus": "Nitro+",
  "nitro.badge.title": "{plan}",
  "nitro.badge.aria": "Plano {plan}",
  "nitro.locked.requires": "Requer {plan}",
  "nitro.locked.open": "{label}: requer {plan}. Ver planos.",
  "nitro.required.title": "Requer Nitro",
  "nitro.required.description":
    "GIFs e outras imagens animadas em avatar e banner são exclusivos de quem tem Nitro. Imagens estáticas (PNG, JPEG e WebP) continuam livres.",
  "nitro.required.cta": "Ver planos",
  "nitro.required.dismiss": "Agora não",
  "nitro.current.title": "Seu plano",
  "nitro.current.description": "O plano ativo agora e como você o recebeu.",
  "nitro.current.free": "Você está no plano Grátis.",
  "nitro.current.plan": "Plano atual: {plan}",
  "nitro.current.permanent": "Permanente, sem data de vencimento.",
  "nitro.current.expires": "Vence em {date}.",
  "nitro.current.loading": "Carregando seu plano…",
  "nitro.current.loadFailed": "Não foi possível carregar seu plano agora.",
  "nitro.source.label": "Origem",
  "nitro.source.admin": "Concedido pela equipe do Spook",
  "nitro.source.code": "Código de resgate",
  "nitro.source.payment": "Pagamento",
  "nitro.source.trial": "Período de cortesia",
  "nitro.expiring.title": "Seu {plan} está perto de vencer",
  "nitro.expiring.body":
    "Vence em {date}. Depois disso você volta ao plano Grátis: seus GIFs passam a aparecer parados e a tela volta a 720p com 30 fps. Nada é apagado, e tudo volta a animar quando o plano for renovado.",
  "nitro.compare.title": "Compare os planos",
  "nitro.compare.description": "O que cada plano libera.",
  "nitro.compare.feature": "Recurso",
  "nitro.compare.current": "Seu plano",
  "nitro.compare.screen": "Compartilhar tela",
  "nitro.compare.screenValue": "Até {height}p, {fps} fps",
  "nitro.compare.animatedAvatar": "Avatar animado (GIF)",
  "nitro.compare.animatedBanner": "Banner animado (GIF)",
  "nitro.compare.badge": "Selo ao lado do nome",
  "nitro.compare.yes": "Incluído",
  "nitro.compare.no": "Não incluído",
  "nitro.compare.note":
    "No plano Grátis, um GIF já enviado aparece parado (primeiro quadro) para todos. O arquivo continua guardado e volta a animar se você tiver Nitro de novo.",
  "nitro.redeem.title": "Resgatar código",
  "nitro.redeem.description":
    "Tem um código do Spook? Cole aqui. Os dias somam à validade do seu plano.",
  "nitro.redeem.label": "Código de resgate",
  "nitro.redeem.placeholder": "SPOOK-XXXX-XXXX-XXXX-XXXX",
  "nitro.redeem.submit": "Resgatar",
  "nitro.redeem.empty": "Digite o código para resgatar.",
  "nitro.redeem.invalid": "Código inválido. Confira os caracteres e tente de novo.",
  "nitro.redeem.used": "Este código já foi usado.",
  "nitro.redeem.expired": "Este código venceu e não pode mais ser resgatado.",
  "nitro.redeem.rateLimited": "Muitas tentativas. Aguarde um pouco e tente de novo.",
  "nitro.redeem.failed": "Não foi possível resgatar agora. Tente de novo em instantes.",
  "nitro.subscribe.title": "Assinar",
  "nitro.subscribe.description": "Pague uma vez e ganhe 30 dias do plano escolhido.",
  "nitro.subscribe.cta": "Assinar {plan}",
  "nitro.subscribe.price": "{price} por {days} dias",
  "nitro.subscribe.unavailable": "O pagamento está indisponível no momento. Tente mais tarde.",
  "nitro.subscribe.rateLimited":
    "Muitas tentativas de pagamento. Aguarde um pouco e tente de novo.",
  "nitro.subscribe.failed": "Não foi possível abrir o pagamento agora. Tente de novo em instantes.",
  "nitro.payment.success.title": "Pagamento recebido",
  "nitro.payment.success.waiting":
    "Estamos ativando o seu plano. Isso costuma levar poucos segundos.",
  "nitro.payment.success.done": "Tudo certo: seu plano {plan} está ativo.",
  "nitro.payment.success.late":
    "O pagamento foi aprovado, mas a ativação ainda não chegou. Ela é automática e pode levar alguns minutos; se passar disso, fale com o suporte.",
  "nitro.payment.failure":
    "O pagamento não foi concluído e nada foi cobrado. Você pode tentar de novo.",
  "nitro.payment.pending":
    "Seu pagamento está pendente. Assim que o Mercado Pago confirmar, o plano é ativado sozinho.",
  "nitro.toast.activated": "{plan} ativado",
  "nitro.toast.expired": "Seu Nitro venceu. Você voltou ao plano Grátis.",
  "nitro.welcome.title": {
    one: "Bem-vindo! Você ganhou {count} dia de {plan}",
    other: "Bem-vindo! Você ganhou {count} dias de {plan}",
  },
  "nitro.welcome.body":
    "É um presente de boas-vindas: aproveite GIFs animados e tela em alta qualidade.",
  "nitro.welcome.cta": "Ver o que inclui",
  "nitro.welcome.dismiss": "Dispensar aviso de boas-vindas",
  "nitro.toast.changed": "Seu plano mudou para {plan}.",
  "voice.quality.lockedHint":
    "Opções com cadeado precisam de Nitro (até 1080p e 60 fps) ou Nitro+ (1440p). Toque em uma para ver os planos.",
} as const satisfies MessageMap;
