package notification

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

type AckBody struct {
	MessageID string `json:"message_id" doc:"ID da última mensagem lida. A leitura nunca regride (vale o maior ID) e é limitada à última mensagem do canal"`
}

type AckOutput struct{ Body UpdatePayload }

type ReadStatesOutput struct {
	Body struct {
		ReadStates []ReadStatePayload      `json:"read_states" nullable:"false" doc:"Um item por canal de texto visível e por DM; unread_count vai até 100 (100 = 100 ou mais, a UI mostra 99+)"`
		Guilds     []GuildReadStatePayload `json:"guilds" nullable:"false" doc:"Agregado por servidor: soma de unread_count (limitada a 100) e de mention_count"`
	}
}

type VAPIDOutput struct {
	Body struct {
		PublicKey string `json:"public_key" doc:"Chave pública VAPID (base64url) para pushManager.subscribe({applicationServerKey})"`
	}
}

type SubscriptionKeys struct {
	P256dh string `json:"p256dh" minLength:"1" maxLength:"256"`
	Auth   string `json:"auth" minLength:"1" maxLength:"256"`
}

type SubscribeBody struct {
	Endpoint string           `json:"endpoint" minLength:"1" maxLength:"2048" doc:"URL https do serviço de push (PushSubscription.endpoint); redes internas são recusadas"`
	Keys     SubscriptionKeys `json:"keys" doc:"PushSubscription.toJSON().keys"`
}

type UnsubscribeBody struct {
	Endpoint string `json:"endpoint" minLength:"1" maxLength:"2048"`
}

func (h *Handler) Register(api huma.API, mw huma.Middlewares, security []map[string][]string) {
	huma.Register(api, huma.Operation{
		OperationID: "ackChannel", Method: http.MethodPut, Path: "/api/channels/{channel_id}/ack",
		Summary: "Marca o canal como lido até uma mensagem (nunca regride; zera as menções ao alcançar a última)",
		Description: "Devolve o estado resultante e também o publica como READ_STATE_UPDATE nas outras sessões do usuário. " +
			"Exige acesso ao canal; só canais de texto e DMs têm estado de leitura.",
		Tags: []string{"notifications"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUnprocessableEntity},
	}, func(ctx context.Context, in *struct {
		ChannelID string `path:"channel_id" doc:"ID do canal ou da DM"`
		Body      AckBody
	}) (*AckOutput, error) {
		cid, ok := httpx.ParseID(in.ChannelID)
		if !ok {
			return nil, httpx.BadID("canal")
		}
		mid, ok := httpx.ParseID(in.Body.MessageID)
		if !ok {
			return nil, httpx.Err(errInvalidMessage)
		}
		up, err := h.svc.Ack(ctx, h.userID(ctx), cid, mid)
		if err != nil {
			return nil, httpx.Err(err)
		}
		return &AckOutput{Body: up}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "listReadStates", Method: http.MethodGet, Path: "/api/users/@me/read-states",
		Summary: "Não lidas e menções por canal e por servidor",
		Description: "Não lidas = mensagens de outros usuários, não apagadas, com ID maior que `last_read_message_id`. Sem leitura registrada a base é a " +
			"entrada do membro no servidor (DM: a criação do canal): o histórico anterior nunca conta como não lido. `unread_count` é " +
			"limitado a 100 por canal (100 = \"100 ou mais\").",
		Tags: []string{"notifications"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized},
	}, func(ctx context.Context, _ *struct{}) (*ReadStatesOutput, error) {
		states, err := h.svc.ReadStates(ctx, h.userID(ctx))
		if err != nil {
			return nil, httpx.Err(err)
		}
		out := &ReadStatesOutput{}
		out.Body.ReadStates = Payloads(states, true)
		out.Body.Guilds = Summarize(states)
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "getVapidPublicKey", Method: http.MethodGet, Path: "/api/push/vapid-public-key",
		Summary: "Chave pública VAPID do Web Push (503 se o push não está configurado)",
		Tags:    []string{"notifications"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusServiceUnavailable},
	}, func(ctx context.Context, _ *struct{}) (*VAPIDOutput, error) {
		key, err := h.svc.VAPIDPublicKey(h.userID(ctx))
		if err != nil {
			return nil, httpx.Err(err)
		}
		out := &VAPIDOutput{}
		out.Body.PublicKey = key
		return out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "subscribePush", Method: http.MethodPost, Path: "/api/push/subscriptions",
		Summary: "Registra (ou atualiza, pelo endpoint) a inscrição de Web Push deste dispositivo (máx. 10 por usuário)",
		Description: "O endpoint precisa ser https e não pode resolver para rede interna (anti-SSRF). Só quem está sem sessão de gateway " +
			"recebe push, e apenas para DMs e menções diretas.",
		DefaultStatus: http.StatusNoContent,
		Tags:          []string{"notifications"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusConflict, http.StatusUnprocessableEntity, http.StatusTooManyRequests, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct{ Body SubscribeBody }) (*struct{}, error) {
		err := h.svc.Subscribe(ctx, h.userID(ctx), in.Body.Endpoint, in.Body.Keys.P256dh, in.Body.Keys.Auth)
		return nil, httpx.Err(err)
	})

	huma.Register(api, huma.Operation{
		OperationID: "unsubscribePush", Method: http.MethodDelete, Path: "/api/push/subscriptions",
		Summary:       "Remove a inscrição de Web Push deste dispositivo (idempotente)",
		DefaultStatus: http.StatusNoContent,
		Tags:          []string{"notifications"}, Security: security, Middlewares: mw,
		Errors: []int{http.StatusUnauthorized, http.StatusTooManyRequests, http.StatusServiceUnavailable},
	}, func(ctx context.Context, in *struct{ Body UnsubscribeBody }) (*struct{}, error) {
		return nil, httpx.Err(h.svc.Unsubscribe(ctx, h.userID(ctx), in.Body.Endpoint))
	})
}
