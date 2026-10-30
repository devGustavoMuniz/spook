package user

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"time"

	"github.com/danielgtaylor/huma/v2"
)

type View struct {
	ID          string    `json:"id" doc:"ID Snowflake (string, pois excede 53 bits)"`
	Email       string    `json:"email"`
	Username    string    `json:"username"`
	DisplayName string    `json:"display_name,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty" doc:"URL temporária de leitura do avatar"`
	CreatedAt   time.Time `json:"created_at"`
}

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

// NewHandler recebe userID para ler o usuário autenticado do contexto, sem importar o pacote auth.
func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

func (h *Handler) View(ctx context.Context, u User) View {
	v := View{
		ID: strconv.FormatInt(u.ID, 10), Email: u.Email, Username: u.Username,
		CreatedAt: u.CreatedAt, AvatarURL: h.svc.AvatarURL(ctx, u),
	}
	if u.DisplayName != nil {
		v.DisplayName = *u.DisplayName
	}
	return v
}

type MeOutput struct{ Body View }

type UpdateProfileInput struct {
	Body struct {
		DisplayName  *string `json:"display_name,omitempty" maxLength:"32" doc:"Vazio remove o nome de exibição"`
		AvatarKey    *string `json:"avatar_key,omitempty" maxLength:"200" doc:"Chave devolvida por /users/me/avatar"`
		RemoveAvatar bool    `json:"remove_avatar,omitempty"`
	}
}

type AvatarInput struct {
	Body struct {
		ContentType string `json:"content_type" enum:"image/png,image/jpeg,image/webp"`
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

	huma.Register(api, op("updateMe", http.MethodPatch, "/api/users/me", "Edita nome de exibição e avatar"),
		func(ctx context.Context, in *UpdateProfileInput) (*MeOutput, error) {
			u, err := h.svc.UpdateProfile(ctx, h.userID(ctx), ProfileUpdate{
				DisplayName: in.Body.DisplayName, AvatarKey: in.Body.AvatarKey, RemoveAvatar: in.Body.RemoveAvatar,
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
}

func mapErr(err error) error {
	switch {
	case errors.Is(err, ErrInvalidAvatar):
		return huma.Error422UnprocessableEntity("avatar inválido: use png, jpeg ou webp de até 5 MB e uma chave gerada para você")
	case errors.Is(err, ErrNotFound):
		return huma.Error404NotFound("usuário não encontrado")
	default:
		return err
	}
}
