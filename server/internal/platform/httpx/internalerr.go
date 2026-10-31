package httpx

import (
	"errors"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"
)

// genericInternalMsg é tudo o que o cliente vê de um erro 5xx.
const genericInternalMsg = "erro interno do servidor; tente novamente em instantes"

func init() {
	// O huma, por padrão, copia o texto do erro (caminho de objeto, mensagem do S3, SQL…) para o corpo da
	// resposta 500. Para qualquer status >= 500 o detalhe vai só para o log e o cliente recebe uma mensagem genérica.
	// Erros 4xx (validação, regras de negócio) continuam com a mensagem original.
	orig := huma.NewError
	huma.NewError = func(status int, msg string, errs ...error) huma.StatusError {
		if status >= http.StatusInternalServerError && status != http.StatusServiceUnavailable {
			slog.Error("erro interno em handler", "status", status, "msg", msg, "err", errors.Join(errs...))
			return orig(status, genericInternalMsg)
		}
		return orig(status, msg, errs...)
	}
}
