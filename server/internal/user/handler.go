package user

import (
	"context"
	"errors"
	"image"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/plan"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
	"github.com/devGustavoMuniz/spook/server/internal/platform/ratelimit"
)

type View struct {
	ID            string    `json:"id" doc:"ID Snowflake (string, pois excede 53 bits)"`
	Email         string    `json:"email"`
	Username      string    `json:"username"`
	DisplayName   string    `json:"display_name,omitempty"`
	AvatarURL     string    `json:"avatar_url,omitempty" doc:"URL temporária de leitura do avatar (pode ser animado: GIF/WebP)"`
	Bio           string    `json:"bio,omitempty" doc:"Sobre mim (até 190 caracteres)"`
	Pronouns      string    `json:"pronouns,omitempty" doc:"Pronomes (até 40 caracteres)"`
	BannerURL     string    `json:"banner_url,omitempty" doc:"URL temporária de leitura do banner (imagem)"`
	BannerColor   *int32    `json:"banner_color,omitempty" doc:"Cor sólida do banner (RGB 0..16777215), usada quando não há imagem"`
	CreatedAt     time.Time `json:"created_at"`
	EmailVerified bool      `json:"email_verified" doc:"O e-mail foi confirmado. Contas antigas começam como não verificadas"`
	PendingEmail  string    `json:"pending_email,omitempty" doc:"Endereço novo aguardando confirmação por e-mail (a troca só vale depois do clique no link)"`
	HasPassword   bool      `json:"has_password" doc:"Falso em contas criadas por login social que ainda não definiram senha"`
	Plan          string    `json:"plan,omitempty" enum:"free,nitro,nitro_plus" doc:"Plano (Grátis, Nitro ou Nitro+). Ausente = free. Validade e origem: GET /api/me/plan"`
	IsAdmin       bool      `json:"is_admin" doc:"Administrador do painel /admin (só para mostrar o link; o backend decide o acesso)"`
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
	v.EmailVerified, v.HasPassword = u.EmailVerifiedAt != nil, u.HasPassword
	if p := h.svc.PlanOf(ctx, u.ID); p != string(plan.Free) {
		v.Plan = p
	}
	if u.PendingEmail != nil {
		v.PendingEmail = *u.PendingEmail
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

// EmailChangeOutput: 200 com a troca feita, ou 202 quando o endereço novo precisa ser confirmado por e-mail.
type EmailChangeOutput struct {
	Status int
	Body   View
}

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

type CropInput struct {
	Body struct {
		Key    string `json:"key" minLength:"1" maxLength:"200" doc:"Chave .gif devolvida por /users/me/avatar ou /users/me/banner, já enviada"`
		X      int    `json:"x" minimum:"0" maximum:"4096" doc:"Esquerda do recorte, em pixels do GIF"`
		Y      int    `json:"y" minimum:"0" maximum:"4096" doc:"Topo do recorte, em pixels do GIF"`
		Width  int    `json:"width" minimum:"1" maximum:"4096" doc:"Largura do recorte em pixels"`
		Height int    `json:"height" minimum:"1" maximum:"4096" doc:"Altura do recorte em pixels"`
	}
}

type CropOutput struct {
	Body struct {
		Key string `json:"key" doc:"Chave do GIF recortado (use em avatar_key ou banner_key); igual à enviada se o recorte cobre a imagem toda"`
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

	// nitro: operações que podem responder 403 `code: nitro_required` (imagem animada sem Nitro).
	nitro := func(o huma.Operation) huma.Operation {
		o.Errors = append(o.Errors, http.StatusForbidden)
		o.Description = "Sem Nitro, GIF, WebP animado e APNG não são aceitos: 403 com `code: nitro_required`."
		return o
	}

	huma.Register(api, op("getMe", http.MethodGet, "/api/users/me", "Perfil do usuário autenticado"),
		func(ctx context.Context, _ *struct{}) (*MeOutput, error) {
			u, err := h.svc.Get(ctx, h.userID(ctx))
			if err != nil {
				return nil, mapErr(err)
			}
			return &MeOutput{Body: h.View(ctx, u)}, nil
		})

	huma.Register(api, nitro(op("updateMe", http.MethodPatch, "/api/users/me", "Edita nome de exibição, avatar, bio, pronomes e banner")),
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

	huma.Register(api, nitro(op("requestAvatarUpload", http.MethodPost, "/api/users/me/avatar", "Gera URL pré-assinada para enviar o avatar")),
		func(ctx context.Context, in *AvatarInput) (*AvatarOutput, error) {
			up, err := h.svc.RequestAvatarUpload(ctx, h.userID(ctx), in.Body.ContentType, in.Body.Size)
			if err != nil {
				return nil, mapErr(err)
			}
			out := &AvatarOutput{}
			out.Body.UploadURL, out.Body.Key = up.URL, up.Key
			return out, nil
		})

	huma.Register(api, nitro(op("requestBannerUpload", http.MethodPost, "/api/users/me/banner", "Gera URL pré-assinada para enviar o banner do perfil")),
		func(ctx context.Context, in *AvatarInput) (*AvatarOutput, error) {
			up, err := h.svc.RequestBannerUpload(ctx, h.userID(ctx), in.Body.ContentType, in.Body.Size)
			if err != nil {
				return nil, mapErr(err)
			}
			out := &AvatarOutput{}
			out.Body.UploadURL, out.Body.Key = up.URL, up.Key
			return out, nil
		})

	cropOp := op("cropProfileImage", http.MethodPost, "/api/users/me/crop-image", "Recorta um GIF (animado) de avatar ou banner já enviado")
	cropOp.Description = "Só GIF: o servidor recorta quadro a quadro preservando a animação, sem redimensionar. Estáticos são recortados no navegador; WebP/APNG animados são usados como estão. 422 com `code` fora do padrão quando o GIF passa dos limites (4096 px, 500 quadros): use o arquivo original."
	cropOp.Description += " Sem Nitro (GIF é do Nitro): 403 com `code: nitro_required`."
	cropOp.Errors = append(cropOp.Errors, http.StatusUnprocessableEntity, http.StatusForbidden)
	huma.Register(api, cropOp, func(ctx context.Context, in *CropInput) (*CropOutput, error) {
		b := in.Body
		key, err := h.svc.CropImage(ctx, h.userID(ctx), b.Key, image.Rect(b.X, b.Y, b.X+b.Width, b.Y+b.Height))
		if err != nil {
			return nil, mapErr(err)
		}
		out := &CropOutput{}
		out.Body.Key = key
		return out, nil
	})

	emailOp := op("changeEmail", http.MethodPut, "/api/users/me/email", "Troca o e-mail (exige confirmação recente de senha)")
	if h.sensitive != nil {
		emailOp.Middlewares = h.sensitive
	}
	emailOp.Description = "Exige a senha confirmada nos últimos 10 min (`POST /api/auth/confirm-password`); sem isso responde 403 com `code: password_confirmation_required`. Limite: 5 trocas por hora."
	emailOp.Errors = append(emailOp.Errors, http.StatusForbidden, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests)
	emailOp.Description += " Com e-mail ativo no servidor, o endereço novo precisa ser confirmado pelo link enviado a ele: a resposta é 202 com `pending_email` e a conta só muda ao confirmar (`POST /api/auth/email/verify`); sem e-mail (modo degradado) a troca é direta (200)."
	huma.Register(api, emailOp, func(ctx context.Context, in *EmailInput) (*EmailChangeOutput, error) {
		uid := h.userID(ctx)
		if err := httpx.Take(h.limiter, "email:"+httpx.ID(uid)); err != nil {
			return nil, err
		}
		u, err := h.svc.ChangeEmail(ctx, uid, in.Body.Email)
		if errors.Is(err, ErrEmailVerificationPending) {
			return &EmailChangeOutput{Status: http.StatusAccepted, Body: h.View(ctx, u)}, nil
		}
		if err != nil {
			return nil, mapErr(err)
		}
		return &EmailChangeOutput{Status: http.StatusOK, Body: h.View(ctx, u)}, nil
	})
}

// CodeNitroRequired é o `code` do 403 de imagem animada sem Nitro.
const CodeNitroRequired = "nitro_required"

func mapErr(err error) error {
	switch {
	case errors.Is(err, ErrNitroRequired):
		return &httpx.ProblemError{Status: http.StatusForbidden, Code: CodeNitroRequired,
			Detail: "GIF e imagens animadas em avatar e banner são exclusivos de quem tem Nitro"}
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
	case errors.Is(err, ErrGIFTooComplex):
		return huma.Error422UnprocessableEntity("gif complexo demais para recortar: use o arquivo como está")
	case errors.Is(err, ErrNotFound):
		return huma.Error404NotFound("usuário não encontrado")
	default:
		return err
	}
}
