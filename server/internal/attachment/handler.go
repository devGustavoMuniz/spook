package attachment

import (
	"context"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type UploadBody struct {
	Filename    string `json:"filename" minLength:"1" maxLength:"255" doc:"Nome original; o servidor tira caminho e caracteres de controle e limita a 100 caracteres"`
	ContentType string `json:"content_type" doc:"Tipo permitido (png, jpeg, gif, webp, pdf, text/plain, zip, audio mpeg/ogg/webm, vídeo mp4/webm); a extensão do nome precisa combinar"`
	Size        int64  `json:"size" doc:"Tamanho em bytes, de 1 a 26214400 (25 MB)"`
}

type UploadOutput struct{ Body UploadPayload }

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "requestUpload", Method: http.MethodPost, Path: "/api/channels/{channel_id}/uploads",
		Summary: "Pede uma URL pré-assinada de PUT para anexar um arquivo (limite: 30 pedidos por minuto)",
		Description: "Cria o anexo pendente. O cliente envia o arquivo direto ao storage (PUT com os cabeçalhos devolvidos) e " +
			"depois cita o `id` em `attachment_ids` ao enviar a mensagem. Anexos não usados em 1 h são apagados.",
		DefaultStatus: http.StatusCreated, Tags: []string{"uploads"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusConflict,
			http.StatusUnprocessableEntity, http.StatusTooManyRequests, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct {
		ChannelID string `path:"channel_id" doc:"ID do canal (servidor ou DM)"`
		Body      UploadBody
	}) (*UploadOutput, error) {
		cid, ok := httpx.ParseID(in.ChannelID)
		if !ok {
			return nil, httpx.BadID("canal")
		}
		p, err := h.svc.RequestUpload(ctx, h.userID(ctx), cid, in.Body.Filename, in.Body.ContentType, in.Body.Size)
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &UploadOutput{Body: p}, nil
	})
}
