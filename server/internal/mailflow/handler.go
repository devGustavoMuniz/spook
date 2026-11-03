package mailflow

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/auth"
	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

// Códigos estáveis (`code`) das respostas de erro, para o cliente decidir o que mostrar sem ler o texto.
const (
	CodeTokenInvalid            = "token_invalid"
	CodeTokenExpired            = "token_expired"
	CodeEmailDisabled           = "email_disabled"
	CodeAlreadyVerified         = "already_verified"
	CodeEmailVerificationNeeded = "email_verification_required"
	tokenPattern                = "^[A-Za-z0-9_-]{20,128}$"
	tokenPatternDescription     = "token do link do e-mail"
)

type Handler struct {
	svc      *Service
	userID   func(context.Context) int64
	required bool
	// Limitadores: por IP (esqueci a senha / redefinir), por usuário (reenvio).
	forgotIP *ratelimit.Limiter
	resend   *ratelimit.Limiter
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

// WithLimiters define os limitadores: forgotIP (por IP) e resend (por usuário).
func (h *Handler) WithLimiters(forgotIP, resend *ratelimit.Limiter) *Handler {
	h.forgotIP, h.resend = forgotIP, resend
	return h
}

// RequireVerified liga a exigência de e-mail verificado (REQUIRE_EMAIL_VERIFICATION) no middleware Gate.
func (h *Handler) RequireVerified(on bool) *Handler { h.required = on; return h }

// Gate é o middleware das ações que exigem e-mail verificado (criar servidor, convidar). Deve vir DEPOIS do
// middleware de sessão. Só barra quando REQUIRE_EMAIL_VERIFICATION=true E o e-mail está ligado: em modo
// degradado ninguém consegue verificar, então nada é bloqueado.
func (h *Handler) Gate(api huma.API) func(huma.Context, func(huma.Context)) {
	return func(ctx huma.Context, next func(huma.Context)) {
		if !h.required || !h.svc.Enabled() {
			next(ctx)
			return
		}
		u, err := h.svc.d.Users.Get(ctx.Context(), h.userID(ctx.Context()))
		if err != nil {
			slog.Error("verificar e-mail da conta", "err", err)
			_ = huma.WriteErr(api, ctx, http.StatusInternalServerError, "erro interno")
			return
		}
		if u.EmailVerifiedAt == nil {
			ctx.SetHeader("Content-Type", "application/problem+json")
			ctx.SetStatus(http.StatusForbidden)
			_ = json.NewEncoder(ctx.BodyWriter()).Encode(&httpx.ProblemError{
				Status: http.StatusForbidden, Code: CodeEmailVerificationNeeded,
				Detail: "verifique seu e-mail para criar servidores e convidar pessoas",
			})
			return
		}
		next(ctx)
	}
}

type VerifyInput struct {
	Body struct {
		Token string `json:"token" pattern:"^[A-Za-z0-9_-]{20,128}$" patternDescription:"token do link do e-mail" minLength:"20" maxLength:"128"`
	}
}

type VerifyOutput struct {
	Body struct {
		Status string `json:"status" enum:"verified,changed" doc:"verified: e-mail confirmado; changed: troca de e-mail concluída"`
		Email  string `json:"email"`
	}
}

type ForgotInput struct {
	Body struct {
		Email string `json:"email" format:"email" maxLength:"254"`
	}
}

type ResetInput struct {
	Body struct {
		Token       string `json:"token" pattern:"^[A-Za-z0-9_-]{20,128}$" patternDescription:"token do link do e-mail" minLength:"20" maxLength:"128"`
		NewPassword string `json:"new_password" minLength:"8" maxLength:"128"`
	}
}

func tokenErr(err error) error {
	switch {
	case errors.Is(err, ErrTokenInvalid):
		return &httpx.ProblemError{Status: http.StatusGone, Code: CodeTokenInvalid, Detail: "link inválido; peça um novo"}
	case errors.Is(err, ErrTokenExpired):
		return &httpx.ProblemError{Status: http.StatusGone, Code: CodeTokenExpired, Detail: "link expirado ou já usado; peça um novo"}
	}
	return err
}

func (h *Handler) Register(api huma.API, authed huma.Middlewares) {
	huma.Register(api, huma.Operation{
		OperationID: "verifyEmail", Method: http.MethodPost, Path: "/api/auth/email/verify",
		Summary: "Confirma o e-mail (cadastro) ou conclui a troca de e-mail, com o token do link",
		Description: "Sem sessão: o link pode abrir em outro navegador. Token de uso único (24 h). Inválido, expirado ou já usado: 410 com `code` " +
			"`token_invalid` ou `token_expired`. O token só trafega no corpo do POST (a página do link o remove da URL).",
		Tags: []string{"auth"}, Errors: []int{http.StatusGone, http.StatusConflict},
	}, func(ctx context.Context, in *VerifyInput) (*VerifyOutput, error) {
		res, err := h.svc.Verify(ctx, in.Body.Token)
		switch {
		case errors.Is(err, ErrEmailTaken):
			return nil, huma.Error409Conflict("esse e-mail já pertence a outra conta")
		case err != nil:
			return nil, tokenErr(err)
		}
		out := &VerifyOutput{}
		out.Body.Status, out.Body.Email = "verified", res.Email
		if res.Changed {
			out.Body.Status = "changed"
		}
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "resendVerificationEmail", Method: http.MethodPost, Path: "/api/auth/email/resend",
		Summary: "Reenvia o e-mail de verificação",
		Description: "Limite: 3 pedidos e depois 1 por minuto por usuário, e por destinatário. 409 `already_verified` se o e-mail já foi " +
			"confirmado; 503 `email_disabled` quando o servidor está sem e-mail (modo degradado).",
		Tags: []string{"auth"}, Security: auth.Security, Middlewares: authed, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusConflict, http.StatusTooManyRequests, http.StatusServiceUnavailable},
	}, func(ctx context.Context, _ *struct{}) (*struct{}, error) {
		uid := h.userID(ctx)
		if err := httpx.Take(h.resend, "resend:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		err := h.svc.Resend(ctx, uid)
		switch {
		case errors.Is(err, ErrDisabled):
			return nil, &httpx.ProblemError{Status: http.StatusServiceUnavailable, Code: CodeEmailDisabled, Detail: "este servidor não envia e-mails"}
		case errors.Is(err, ErrAlreadyVerified):
			return nil, &httpx.ProblemError{Status: http.StatusConflict, Code: CodeAlreadyVerified, Detail: "seu e-mail já está verificado"}
		case err != nil:
			return nil, httpx.Err(err)
		}
		return nil, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "forgotPassword", Method: http.MethodPost, Path: "/api/auth/password/forgot",
		Summary: "Pede o link de redefinição de senha por e-mail",
		Description: "A resposta é SEMPRE a mesma (202), exista ou não conta com esse e-mail, e demora um mínimo fixo para o tempo não revelar nada. " +
			"Limite por IP (5 e depois 1 a cada 2 min) e por e-mail (silencioso: acima do limite nada é enviado). O link vale 30 min, uso único.",
		Tags: []string{"auth"}, DefaultStatus: http.StatusAccepted, Errors: []int{http.StatusTooManyRequests},
	}, func(ctx context.Context, in *ForgotInput) (*struct{}, error) {
		if err := httpx.Take(h.forgotIP, "forgot:"+httpx.ClientIP(ctx)); err != nil {
			return nil, err
		}
		h.svc.Forgot(ctx, in.Body.Email)
		return nil, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "resetPassword", Method: http.MethodPost, Path: "/api/auth/password/reset",
		Summary:     "Redefine a senha com o token do e-mail (encerra TODAS as sessões)",
		Description: "Token de uso único (30 min). Senha fora das regras (8 a 128) responde 422 sem gastar o token. Inválido/expirado: 410 com `code`.",
		Tags:        []string{"auth"}, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusGone, http.StatusUnprocessableEntity, http.StatusTooManyRequests},
	}, func(ctx context.Context, in *ResetInput) (*struct{}, error) {
		if err := httpx.Take(h.forgotIP, "reset:"+httpx.ClientIP(ctx)); err != nil {
			return nil, err
		}
		err := h.svc.Reset(ctx, in.Body.Token, in.Body.NewPassword)
		switch {
		case errors.Is(err, auth.ErrWeakPassword):
			return nil, huma.Error422UnprocessableEntity("a senha deve ter de 8 a 128 caracteres")
		case err != nil:
			if apperr.IsKind(err, apperr.KindRateLimited) {
				return nil, httpx.Err(err)
			}
			return nil, tokenErr(err)
		}
		return nil, nil
	})
}
