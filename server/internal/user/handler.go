package user

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

type View struct {
	ID          string    `json:"id" doc:"ID Snowflake (string, pois excede 53 bits)"`
	Email       string    `json:"email"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty" doc:"URL temporária de leitura do avatar (pode ser animado: GIF/WebP)"`
	Bio         string    `json:"bio,omitempty" doc:"Sobre mim (até 190 caracteres)"`
	Pronouns    string    `json:"pronouns,omitempty" doc:"Pronomes (até 40 caracteres)"`
	BannerURL   string    `json:"banner_url,omitempty" doc:"URL temporária de leitura do banner (imagem)"`
	BannerColor *int32    `json:"banner_color,omitempty" doc:"Cor sólida do banner (RGB 0..16777215), usada quando não há imagem"`
	CreatedAt   time.Time `json:"created_at"`
	IsAdmin     bool      `json:"is_admin" doc:"Administrador do painel /admin (só para mostrar o link; o backend decide o acesso)"`
}

type Handler struct {
	svc       *Service
	userID    func(context.Context) int64
	sensitive huma.Middlewares // sessão + confirmação recente de senha (ações sensíveis)
	limiter   *ratelimit.Limiter
}

// WithSensitive define os middlewares das ações que exigem confirmação recente de senha.
func (h *Handler) WithSensitive(mw huma.Middlewares) *Handler { h.sensitive = mw; return h }

// WithLimiter define o limitador por ação e usuário (troca de e-mail).
func (h *Handler) WithLimiter(l *ratelimit.Limiter) *Handler { h.limiter = l; return h }

// NewHandler recebe userID para ler o usuário autenticado do contexto, sem importar o pacote auth.
func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

func (h *Handler) View(ctx context.Context, u User) View {
	v := View{
		ID: strconv.FormatInt(u.ID, 10), Email: u.Email, Username: u.Username,
		CreatedAt: u.CreatedAt, AvatarURL: h.svc.AvatarURL(ctx, u), IsAdmin: u.IsAdmin,
	}
	if u.DisplayName != nil {
		v.DisplayName = *u.DisplayName
	}
	if u.Bio != nil {
		v.Bio = *u.Bio
	}
	if u.Pronouns != nil {
		v.Pronouns = *u.Pronouns
	}
	v.BannerURL, v.BannerColor = h.svc.AvatarURLForKey(ctx, u.BannerKey), u.BannerColor
	return v
}

type MeOutput struct{ Body View }

type UpdateProfileInput struct {
	Body struct {
		DisplayName  *string `json:"display_name,omitempty" maxLength:"32" doc:"Vazio remove o nome de exibição"`
		AvatarKey    *string `json:"avatar_key,omitempty" maxLength:"200" doc:"Chave devolvida por /users/me/avatar"`
		RemoveAvatar bool    `json:"remove_avatar,omitempty"`
		Bio          *string `json:"bio,omitempty" maxLength:"190" doc:"Sobre mim; vazio remove"`
		Pronouns     *string `json:"pronouns,omitempty" maxLength:"40" doc:"Pronomes; vazio remove"`
		BannerKey    *string `json:"banner_key,omitempty" maxLength:"200" doc:"Chave devolvida por /users/me/banner (imagem). Não combine com banner_color"`
		BannerColor  *int32  `json:"banner_color,omitempty" minimum:"0" maximum:"16777215" doc:"Cor sólida do banner (RGB). Não combine com banner_key"`
		RemoveBanner bool    `json:"remove_banner,omitempty" doc:"Remove imagem e cor do banner"`
	}
}

type EmailInput struct {
	Body struct {
		Email string `json:"email" format:"email" maxLength:"254"`
	}
}

type AvatarInput struct {
	Body struct {
		ContentType string `json:"content_type" enum:"image/png,image/jpeg,image/webp,image/gif" doc:"GIF e WebP animados são preservados"`
		Size        int64  `json:"size" minimum:"1" maximum:"5242880" doc:"Tamanho em bytes (máx. 5 MB)"`
	}
}

type AvatarOutput struct {
	Body struct {
		UploadURL string `json:"upload_url" doc:"URL pré-assinada para PUT; envie o Content-Type e o tamanho declarados"`
		Key       string `json:"key"`
	}
}

// Register registra as rotas autenticadas; mw deve exigir sessão válida.
func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary,
			Tags: []string{"users"}, Security: security, Middlewares: mw,
			Errors: []int{http.StatusUnauthorized},
		}
	}

	huma.Register(api, op("getMe", http.MethodGet, "/api/users/me", "Perfil do usuário autenticado"),
		func(ctx context.Context, _ *struct{}) (*MeOutput, error) {
			u, err := h.svc.Get(ctx, h.userID(ctx))
			if err != nil {
				return nil, mapErr(err)
			}
			return &MeOutput{Body: h.View(ctx, u)}, nil
		})

	huma.Register(api, op("updateMe", http.MethodPatch, "/api/users/me", "Edita nome de exibição, avatar, bio, pronomes e banner"),
		func(ctx context.Context, in *UpdateProfileInput) (*MeOutput, error) {
			u, err := h.svc.UpdateProfile(ctx, h.userID(ctx), ProfileUpdate{
				DisplayName: in.Body.DisplayName, AvatarKey: in.Body.AvatarKey, RemoveAvatar: in.Body.RemoveAvatar,
				Bio: in.Body.Bio, Pronouns: in.Body.Pronouns, BannerKey: in.Body.BannerKey,
				BannerColor: in.Body.BannerColor, RemoveBanner: in.Body.RemoveBanner,
			})
			if err != nil {
				return nil, mapErr(err)
			}
			return &MeOutput{Body: h.View(ctx, u)}, nil
		})

	huma.Register(api, op("requestAvatarUpload", http.MethodPost, "/api/users/me/avatar", "Gera URL pré-assinada para enviar o avatar"),
		func(ctx context.Context, in *AvatarInput) (*AvatarOutput, error) {
			up, err := h.svc.RequestAvatarUpload(ctx, h.userID(ctx), in.Body.ContentType, in.Body.Size)
			if err != nil {
				return nil, mapErr(err)
			}
			out := &AvatarOutput{}
			out.Body.UploadURL, out.Body.Key = up.URL, up.Key
			return out, nil
		})

	huma.Register(api, op("requestBannerUpload", http.MethodPost, "/api/users/me/banner", "Gera URL pré-assinada para enviar o banner do perfil"),
		func(ctx context.Context, in *AvatarInput) (*AvatarOutput, error) {
			up, err := h.svc.RequestBannerUpload(ctx, h.userID(ctx), in.Body.ContentType, in.Body.Size)
			if err != nil {
				return nil, mapErr(err)
			}
			out := &AvatarOutput{}
			out.Body.UploadURL, out.Body.Key = up.URL, up.Key
			return out, nil
		})

	emailOp := op("changeEmail", http.MethodPut, "/api/users/me/email", "Troca o e-mail (exige confirmação recente de senha)")
	if h.sensitive != nil {
		emailOp.Middlewares = h.sensitive
	}
	emailOp.Description = "Exige a senha confirmada nos últimos 10 min (`POST /api/auth/confirm-password`); sem isso responde 403 com `code: password_confirmation_required`. Limite: 5 trocas por hora."
	emailOp.Errors = append(emailOp.Errors, http.StatusForbidden, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests)
	huma.Register(api, emailOp, func(ctx context.Context, in *EmailInput) (*MeOutput, error) {
		uid := h.userID(ctx)
		if err := httpx.Take(h.limiter, "email:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		u, err := h.svc.ChangeEmail(ctx, uid, in.Body.Email)
		if err != nil {
			return nil, mapErr(err)
		}
		return &MeOutput{Body: h.View(ctx, u)}, nil
	})
}

func mapErr(err error) error {
	switch {
	case errors.Is(err, ErrInvalidBanner):
		return huma.Error422UnprocessableEntity("banner inválido: use png, jpeg, webp ou gif de até 5 MB, uma chave gerada para você, e escolha imagem OU cor")
	case errors.Is(err, ErrInvalidProfile):
		return huma.Error422UnprocessableEntity("perfil inválido: a bio aceita até 190 caracteres e os pronomes até 40")
	case errors.Is(err, ErrInvalidEmail):
		return huma.Error422UnprocessableEntity("e-mail inválido")
	case errors.Is(err, ErrEmailTaken):
		return huma.Error409Conflict("e-mail já cadastrado")
	case errors.Is(err, ErrEmailVerificationPending):
		return huma.Error409Conflict("a troca de e-mail aguarda a confirmação no endereço novo")
	case errors.Is(err, ErrInvalidAvatar):
		return huma.Error422UnprocessableEntity("avatar inválido: use png, jpeg, webp ou gif de até 5 MB e uma chave gerada para você")
	case errors.Is(err, ErrNotFound):
		return huma.Error404NotFound("usuário não encontrado")
	default:
		return err
	}
}
