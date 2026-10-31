package voice

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"

	"github.com/danielgtaylor/huma/v2"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
	"github.com/devGustavoMuniz/spook/server/internal/platform/httpx"
)

// MaxWebhookBody limita o corpo do webhook (os eventos do LiveKit têm poucos KB).
const MaxWebhookBody = 1 << 20

// WebhookPath é a rota que o LiveKit chama (fora do rate limit por IP e sem sessão de usuário).
const WebhookPath = "/api/livekit/webhook"

type Handler struct {
	svc    *Service
	userID func(context.Context) int64
}

func NewHandler(svc *Service, userID func(context.Context) int64) *Handler {
	return &Handler{svc: svc, userID: userID}
}

type TokenOutput struct{ Body TokenResponse }
type StateOutput struct{ Body StatePayload }
type StatesOutput struct{ Body []StatePayload }

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "createVoiceToken", Method: http.MethodPost, Path: "/api/channels/{channel_id}/voice/token",
		Summary: "Emite o token do LiveKit para entrar na voz do canal (servidor ou DM). Vale 10 min e só para a sala do canal; entrar em outro canal tira o usuário do anterior",
		Tags:    []string{"voice"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound,
			http.StatusUnprocessableEntity, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct {
		ChannelID string `path:"channel_id" doc:"ID do canal de voz ou da DM"`
	}) (*TokenOutput, error) {
		cid, ok := httpx.ParseID(in.ChannelID)
		if !ok {
			return nil, httpx.BadID("canal")
		}
		t, err := h.svc.IssueToken(ctx, h.userID(ctx), cid)
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &TokenOutput{Body: t}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "leaveVoice", Method: http.MethodPost, Path: "/api/voice/leave",
		Summary: "Sai do canal de voz atual (idempotente)",
		Tags:    []string{"voice"}, Security: security, Middlewares: mw, DefaultStatus: http.StatusNoContent,
		Errors: []int{http.StatusUnauthorized, http.StatusServiceUnavailable},
	}, func(ctx context.Context, _ *struct{}) (*struct{}, error) {
		return nil, httpx.Err(h.svc.Leave(ctx, h.userID(ctx)))
	})

	huma.Register(api, huma.Operation{
		OperationID: "updateVoiceState", Method: http.MethodPatch, Path: "/api/voice/state",
		Summary: "Atualiza mute/deafen (estado do cliente); 409 se o usuário não está em um canal de voz",
		Tags:    []string{"voice"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusConflict, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct {
		Body struct {
			SelfMute bool `json:"self_mute"`
			SelfDeaf bool `json:"self_deaf"`
		}
	}) (*StateOutput, error) {
		p, err := h.svc.SetSelfState(ctx, h.userID(ctx), in.Body.SelfMute, in.Body.SelfDeaf)
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &StateOutput{Body: p}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listGuildVoiceStates", Method: http.MethodGet, Path: "/api/guilds/{guild_id}/voice-states",
		Summary: "Quem está em cada canal de voz do servidor agora (snapshot; os updates vêm em VOICE_STATE_UPDATE)",
		Tags:    []string{"voice"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct {
		GuildID string `path:"guild_id" doc:"ID do servidor"`
	}) (*StatesOutput, error) {
		gid, ok := httpx.ParseID(in.GuildID)
		if !ok {
			return nil, httpx.BadID("servidor")
		}
		sts, err := h.svc.GuildStates(ctx, h.userID(ctx), gid)
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &StatesOutput{Body: sts}, nil
	})
}

// WebhookHandler é o endpoint que o LiveKit chama. Não usa sessão de usuário: a autenticidade vem
// da assinatura (JWT no Authorization com o hash do corpo). Fica fora do OpenAPI.
func (h *Handler) WebhookHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !h.svc.Enabled() {
			http.Error(w, ErrDisabled.Msg, http.StatusServiceUnavailable)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, MaxWebhookBody))
		if err != nil {
			var tooBig *http.MaxBytesError
			if errors.As(err, &tooBig) {
				http.Error(w, "corpo grande demais", http.StatusRequestEntityTooLarge)
			} else {
				http.Error(w, "corpo ilegível", http.StatusBadRequest)
			}
			return
		}
		switch err := h.svc.HandleWebhook(r.Context(), r.Header.Get("Authorization"), body); {
		case err == nil:
			w.WriteHeader(http.StatusOK)
		case errors.Is(err, ErrInvalidSignature):
			http.Error(w, "assinatura inválida", http.StatusUnauthorized)
		case apperr.IsKind(err, apperr.KindUnavailable):
			http.Error(w, ErrDisabled.Msg, http.StatusServiceUnavailable)
		default:
			slog.Error("voice: webhook falhou", "err", err) // 5xx: o LiveKit tenta de novo
			http.Error(w, "erro interno", http.StatusInternalServerError)
		}
	})
}
