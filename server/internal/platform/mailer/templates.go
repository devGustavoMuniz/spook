package mailer

import (
	"fmt"
	"html"
	"strings"
)

// Template identifica um e-mail transacional.
type Template string

const (
	TemplateVerify            Template = "verify"
	TemplateEmailChange       Template = "email_change"        // ao NOVO endereço, com o link de confirmação
	TemplateEmailChangeNotice Template = "email_change_notice" // ao endereço ANTIGO: alguém pediu a troca
	TemplateEmailChanged      Template = "email_changed"       // ao endereço ANTIGO: a troca foi concluída
	TemplatePasswordReset     Template = "password_reset"
)

// Data são os valores de um e-mail. URL é o link de ação (com o token) e Other o outro endereço citado.
type Data struct {
	To       string
	Username string
	URL      string
	Other    string
	TTL      string // "24 horas", "30 minutos"
	AppName  string // padrão "Spook"
}

// Render monta assunto, texto e HTML (pt-br; sem imagens remotas, só CSS inline). Tudo que vem de dados é
// escapado no HTML.
func Render(t Template, d Data) (Message, error) {
	if d.AppName == "" {
		d.AppName = "Spook"
	}
	greet := "Olá"
	if d.Username != "" {
		greet = "Olá, " + d.Username
	}
	var subject, intro, action, outro string
	switch t {
	case TemplateVerify:
		subject = "Confirme seu e-mail no " + d.AppName
		intro = "Confirme que este endereço de e-mail é seu para terminar de configurar sua conta."
		action = "Confirmar e-mail"
		outro = fmt.Sprintf("O link vale por %s e só pode ser usado uma vez. Se não foi você, ignore esta mensagem.", d.TTL)
	case TemplateEmailChange:
		subject = "Confirme o novo e-mail da sua conta no " + d.AppName
		intro = "Recebemos um pedido para usar este endereço na sua conta. A troca só acontece depois da sua confirmação."
		action = "Confirmar novo e-mail"
		outro = fmt.Sprintf("O link vale por %s e só pode ser usado uma vez. Se não foi você, ignore esta mensagem: nada será alterado.", d.TTL)
	case TemplateEmailChangeNotice:
		subject = "Pedido de troca de e-mail na sua conta do " + d.AppName
		intro = fmt.Sprintf("Alguém pediu para trocar o e-mail da sua conta para %s. A troca só vale se for confirmada no endereço novo.", d.Other)
		outro = "Se não foi você, troque sua senha agora: o pedido some sozinho se ninguém confirmar."
	case TemplateEmailChanged:
		subject = "O e-mail da sua conta do " + d.AppName + " foi alterado"
		intro = fmt.Sprintf("O e-mail da sua conta agora é %s. Você não receberá mais mensagens neste endereço.", d.Other)
		outro = "Se não foi você, entre em contato com o administrador do servidor imediatamente."
	case TemplatePasswordReset:
		subject = "Redefinir sua senha do " + d.AppName
		intro = "Recebemos um pedido para redefinir a senha da sua conta."
		action = "Redefinir senha"
		outro = fmt.Sprintf("O link vale por %s e só pode ser usado uma vez; ao redefinir, todas as sessões são encerradas. Se não foi você, ignore esta mensagem: sua senha continua a mesma.", d.TTL)
	default:
		return Message{}, fmt.Errorf("modelo de e-mail desconhecido: %q", t)
	}

	var txt strings.Builder
	txt.WriteString(greet + ",\n\n" + intro + "\n\n")
	if action != "" {
		txt.WriteString(action + ": " + d.URL + "\n\n")
	}
	txt.WriteString(outro + "\n\n-- " + d.AppName + "\n")

	var h strings.Builder
	e := html.EscapeString
	h.WriteString(`<!doctype html><html lang="pt-BR"><body style="margin:0;background:#fbfafe;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:#17132a">`)
	h.WriteString(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">`)
	h.WriteString(`<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border:1px solid #e3def2;border-radius:12px" cellpadding="0" cellspacing="0"><tr><td style="padding:28px">`)
	h.WriteString(`<p style="margin:0 0 20px;font-size:20px;font-weight:700;color:#7c5cc4">` + e(d.AppName) + `</p>`)
	h.WriteString(`<p style="margin:0 0 12px;font-size:16px">` + e(greet) + `,</p>`)
	h.WriteString(`<p style="margin:0 0 20px;font-size:15px;line-height:1.5">` + e(intro) + `</p>`)
	if action != "" {
		h.WriteString(`<p style="margin:0 0 20px"><a href="` + e(d.URL) + `" style="display:inline-block;background:#7c5cc4;color:#ffffff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:8px">` + e(action) + `</a></p>`)
		h.WriteString(`<p style="margin:0 0 20px;font-size:13px;color:#5b5473;word-break:break-all">Se o botão não funcionar, copie este endereço no navegador:<br>` + e(d.URL) + `</p>`)
	}
	h.WriteString(`<p style="margin:0;font-size:13px;line-height:1.5;color:#5b5473">` + e(outro) + `</p>`)
	h.WriteString(`</td></tr></table></td></tr></table></body></html>`)
	return Message{To: d.To, Subject: subject, Text: txt.String(), HTML: h.String()}, nil
}
