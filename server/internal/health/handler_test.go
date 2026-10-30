package health

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

type fakePinger struct{ err error }

func (f fakePinger) Ping(context.Context) error { return f.err }

func TestHandler(t *testing.T) {
	tests := []struct {
		name string
		err  error
		want int
	}{
		{"banco saudável", nil, http.StatusOK},
		{"banco fora do ar", errors.New("down"), http.StatusServiceUnavailable},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			NewHandler(fakePinger{tt.err}).ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			if rec.Code != tt.want {
				t.Fatalf("status = %d, esperado %d", rec.Code, tt.want)
			}
		})
	}
}
