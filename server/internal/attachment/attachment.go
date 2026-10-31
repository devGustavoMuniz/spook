// Package attachment cuida dos anexos das mensagens (RF10): pedido de URL pré-assinada, validação
// no envio da mensagem, URLs de leitura e thumbnails assíncronos (jobs River).
package attachment

import (
	"time"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

const (
	// MaxFileSize é o tamanho máximo de um anexo (SPEC 7.3).
	MaxFileSize = 25 << 20
	// MaxPerMessage é o máximo de anexos numa mensagem (SPEC 7.3).
	MaxPerMessage = 10
	// MaxPending limita os anexos pedidos e ainda não enviados em mensagem, por usuário.
	MaxPending = 30
	// MaxFilenameRunes é o tamanho máximo do nome (depois da sanitização).
	MaxFilenameRunes = 100

	// UploadTTL é a validade da URL de PUT; ReadTTL, a das URLs de leitura entregues nas mensagens.
	UploadTTL = 5 * time.Minute
	ReadTTL   = time.Hour
	// ClaimWindow é quanto tempo um anexo pode esperar a mensagem; depois disso vira órfão e é apagado.
	ClaimWindow = time.Hour

	// Thumbnails: cabem em 400x400; imagens maiores que os limites abaixo não são decodificadas
	// (o container tem pouca RAM).
	ThumbMaxDim    = 400
	ThumbQuality   = 80
	SourceMaxSide  = 8192
	SourceMaxPixel = 12_000_000
)

var (
	ErrInvalidAttachments = apperr.Invalid("anexo inválido, de outro usuário, de outro canal ou expirado")
	ErrUploadsDisabled    = apperr.Unavailable("uploads desligados neste servidor")
)

// Attachment é uma linha de attachments.
type Attachment struct {
	ID           int64
	MessageID    *int64
	UploaderID   int64
	ObjectKey    string
	Filename     string
	ContentType  string
	Size         int64
	Width        *int32
	Height       *int32
	ThumbnailKey *string
	CreatedAt    time.Time
}

// AttachmentPayload é o anexo na API e nos eventos de mensagem.
type AttachmentPayload struct {
	ID           string `json:"id"`
	Filename     string `json:"filename"`
	ContentType  string `json:"content_type"`
	Size         int64  `json:"size"`
	URL          string `json:"url" doc:"GET pré-assinado, válido por 1 h"`
	ThumbnailURL string `json:"thumbnail_url,omitempty" doc:"Só em imagens, depois que o job de thumbnail termina (chega por MESSAGE_UPDATE)"`
	Width        *int32 `json:"width,omitempty" doc:"Largura original; imagens processadas pelo job"`
	Height       *int32 `json:"height,omitempty" doc:"Altura original; imagens processadas pelo job"`
}

// UploadPayload é a resposta do pedido de upload.
type UploadPayload struct {
	ID        string            `json:"id" doc:"Use em attachment_ids ao enviar a mensagem"`
	UploadURL string            `json:"upload_url" doc:"PUT pré-assinado; envie o arquivo cru como corpo"`
	Headers   map[string]string `json:"headers" doc:"Cabeçalhos que o PUT precisa enviar exatamente assim"`
	ExpiresIn int               `json:"expires_in" doc:"Segundos até a URL de PUT expirar"`
}

// IsImage diz se o tipo é uma imagem que o job de thumbnail sabe decodificar.
func IsImage(contentType string) bool {
	switch contentType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	}
	return false
}

// ThumbnailKey é a chave do thumbnail de um anexo.
func thumbnailKey(id int64, ext string) string { return "thumbnails/" + httpx.ID(id) + "." + ext }
