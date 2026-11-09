package billing

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	mpBaseURL      = "https://api.mercadopago.com"
	mpTimeout      = 10 * time.Second
	mpMaxResponse  = 1 << 20
	mpErrBodyChars = 300
)

// MercadoPago implementa Gateway sobre a API HTTP do Mercado Pago. O Access Token só vai no cabeçalho
// Authorization e nunca aparece em erros nem em logs.
type MercadoPago struct {
	token  string
	base   string
	client *http.Client
}

// NewMercadoPago usa a API oficial; baseURL vazio = api.mercadopago.com (os testes apontam para um httptest).
func NewMercadoPago(accessToken, baseURL string) *MercadoPago {
	if baseURL == "" {
		baseURL = mpBaseURL
	}
	return &MercadoPago{token: accessToken, base: strings.TrimRight(baseURL, "/"), client: &http.Client{Timeout: mpTimeout}}
}

var _ Gateway = (*MercadoPago)(nil)

func (m *MercadoPago) do(ctx context.Context, method, path string, idemKey string, in, out any) (int, error) {
	var body io.Reader
	if in != nil {
		b, err := json.Marshal(in)
		if err != nil {
			return 0, fmt.Errorf("mercadopago: montar corpo: %w", err)
		}
		body = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, m.base+path, body)
	if err != nil {
		return 0, fmt.Errorf("mercadopago: montar requisição: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+m.token)
	req.Header.Set("Accept", "application/json")
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if idemKey != "" {
		req.Header.Set("X-Idempotency-Key", idemKey)
	}
	resp, err := m.client.Do(req)
	if err != nil {
		// url.Error repete a URL (sem segredos); o token só está no cabeçalho.
		return 0, fmt.Errorf("mercadopago: %s %s: %w", method, path, err)
	}
	defer func() { _ = resp.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, mpMaxResponse))
	if err != nil {
		return resp.StatusCode, fmt.Errorf("mercadopago: ler resposta: %w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		msg := string(raw)
		if len(msg) > mpErrBodyChars {
			msg = msg[:mpErrBodyChars]
		}
		return resp.StatusCode, fmt.Errorf("mercadopago: %s %s: status %d: %s", method, path, resp.StatusCode, msg)
	}
	if err := json.Unmarshal(raw, out); err != nil {
		return resp.StatusCode, fmt.Errorf("mercadopago: resposta ilegível: %w", err)
	}
	return resp.StatusCode, nil
}

type prefItem struct {
	ID         string  `json:"id"`
	Title      string  `json:"title"`
	Quantity   int     `json:"quantity"`
	UnitPrice  float64 `json:"unit_price"`
	CurrencyID string  `json:"currency_id"`
}

type backURLs struct {
	Success string `json:"success"`
	Failure string `json:"failure"`
	Pending string `json:"pending"`
}

type prefRequest struct {
	Items             []prefItem `json:"items"`
	ExternalReference string     `json:"external_reference"`
	NotificationURL   string     `json:"notification_url"`
	BackURLs          backURLs   `json:"back_urls"`
	AutoReturn        string     `json:"auto_return,omitempty"`
}

func (m *MercadoPago) CreatePreference(ctx context.Context, p Preference) (PreferenceResult, error) {
	req := prefRequest{
		Items:             []prefItem{{ID: p.ExternalReference, Title: p.Title, Quantity: 1, UnitPrice: float64(p.AmountCents) / 100, CurrencyID: Currency}},
		ExternalReference: p.ExternalReference,
		NotificationURL:   p.NotificationURL,
		BackURLs:          backURLs{Success: p.SuccessURL, Failure: p.FailureURL, Pending: p.PendingURL},
	}
	if p.AutoReturn {
		req.AutoReturn = "approved"
	}
	var out struct {
		ID        string `json:"id"`
		InitPoint string `json:"init_point"`
	}
	if _, err := m.do(ctx, http.MethodPost, "/checkout/preferences", p.IdempotencyKey, req, &out); err != nil {
		return PreferenceResult{}, err
	}
	if out.InitPoint == "" {
		return PreferenceResult{}, fmt.Errorf("mercadopago: preferência sem init_point")
	}
	return PreferenceResult{ID: out.ID, InitPoint: out.InitPoint}, nil
}

func (m *MercadoPago) GetPayment(ctx context.Context, id int64) (MPPayment, error) {
	var out struct {
		ID                int64   `json:"id"`
		Status            string  `json:"status"`
		StatusDetail      string  `json:"status_detail"`
		ExternalReference string  `json:"external_reference"`
		Amount            float64 `json:"transaction_amount"`
		Currency          string  `json:"currency_id"`
	}
	code, err := m.do(ctx, http.MethodGet, "/v1/payments/"+url.PathEscape(strconv.FormatInt(id, 10)), "", nil, &out)
	if code == http.StatusNotFound {
		return MPPayment{}, ErrPaymentNotFound
	}
	if err != nil {
		return MPPayment{}, err
	}
	return MPPayment{ID: out.ID, Status: out.Status, StatusDetail: out.StatusDetail, ExternalReference: out.ExternalReference, Amount: out.Amount, Currency: out.Currency}, nil
}
