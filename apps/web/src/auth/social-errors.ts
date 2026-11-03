/** Mensagens (pt-br) dos códigos de `?social_error=` devolvidos pelo backend depois do login social. */
const MESSAGES: Record<string, string> = {
  denied: "Você cancelou o acesso no provedor. Nada foi alterado.",
  state: "Essa tentativa de entrada expirou ou é inválida. Tente de novo.",
  provider_error: "Não foi possível falar com o provedor agora. Tente de novo em instantes.",
  provider_off: "Esse provedor de login não está disponível neste servidor.",
  no_email:
    "O provedor não informou um e-mail para a sua conta, então não dá para criar o cadastro.",
  email_unverified:
    "O e-mail da sua conta no provedor não está verificado. Verifique-o lá e tente de novo.",
  email_in_use:
    "Já existe uma conta com esse e-mail. Entre com a sua senha e vincule o provedor em Configurações > Perfil.",
  already_linked: "Essa conta do provedor já está vinculada a outro usuário.",
  provider_linked: "Sua conta já tem esse provedor vinculado.",
  wrong_account: "Você entrou com outra conta do provedor. Use a que está vinculada à sua conta.",
  need_session: "Entre na sua conta antes de vincular um provedor.",
  need_confirm: "Confirme sua senha antes de vincular um provedor.",
  internal: "Algo deu errado do nosso lado. Tente de novo em instantes.",
};

export function socialErrorMessage(code: string | undefined): string | undefined {
  if (!code) return undefined;
  return MESSAGES[code] ?? "Não foi possível concluir o login com o provedor.";
}
