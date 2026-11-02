package voice

import (
	"context"
	"errors"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// Prévia da transmissão (adicional ao SPEC): quem compartilha a tela envia uma miniatura JPEG a cada
// ~15 s; quem vê o canal de voz enxerga a miniatura antes de entrar na transmissão. Só em memória, com
// TTL curto e tetos globais (o container tem 512 MB).
const (
	// PreviewMaxBytes é o maior JPEG aceito (o cliente manda ≤ 40 KB).
	PreviewMaxBytes = 64 << 10
	// PreviewMaxWidth e PreviewMaxHeight limitam as dimensões (o cliente manda 320×180).
	PreviewMaxWidth  = 640
	PreviewMaxHeight = 360
	// PreviewTTL é por quanto tempo uma prévia vale sem ser renovada.
	PreviewTTL = 45 * time.Second
	// PreviewMinInterval é o intervalo mínimo entre dois envios do mesmo usuário.
	PreviewMinInterval = 5 * time.Second
	// PreviewMaxCount e PreviewMaxTotalBytes são os tetos globais da memória das prévias.
	PreviewMaxCount      = 200
	PreviewMaxTotalBytes = 12 << 20
	// previewSweepEvery é de quanto em quanto tempo o Run varre as prévias vencidas.
	previewSweepEvery = 15 * time.Second
)

var (
	// ErrPreviewCapacity indica que o teto global de prévias foi atingido (o cliente tenta de novo depois).
	ErrPreviewCapacity = errors.New("limite de prévias atingido")

	ErrPreviewNotFound = apperr.NotFound("prévia da transmissão não encontrada")
	errPreviewDisabled = apperr.Unavailable("prévia da transmissão indisponível neste servidor")
	errNotInChannel    = apperr.Forbidden("você não está na chamada deste canal")
	errNoVideoPerm     = apperr.Forbidden("você não tem permissão para transmitir neste canal")
	errPreviewEmpty    = apperr.Invalid("a prévia precisa ser uma imagem JPEG")
	errPreviewFormat   = apperr.Invalid("a prévia precisa ser uma imagem JPEG válida")
	errPreviewSize     = apperr.Invalid("a prévia pode ter no máximo 640×360 pixels")
)

// Preview é a miniatura da tela de um usuário.
type Preview struct {
	UserID    int64
	ChannelID int64
	Data      []byte
	ExpiresAt time.Time
}

// PreviewStore guarda as prévias (uma por usuário). Implementação segura para uso concorrente.
type PreviewStore interface {
	// Put substitui a prévia do usuário. ErrPreviewCapacity se os tetos estourariam (quem chama varre
	// as vencidas com Sweep e tenta de novo).
	Put(p Preview, now time.Time) error
	// Get devolve a prévia do usuário no canal; vencida = ausente.
	Get(userID, channelID int64, now time.Time) (Preview, bool)
	// Delete remove a prévia do usuário; devolve se havia uma.
	Delete(userID int64) bool
	// Sweep remove as vencidas e devolve os usuários afetados.
	Sweep(now time.Time) []int64
	// Stats devolve quantas prévias e quantos bytes estão guardados.
	Stats() (count, bytes int)
}

// validateJPEG confere o formato sem decodificar a imagem: magic bytes (FFD8FF), fim (FFD9) e as
// dimensões lidas do primeiro marcador SOF.
func validateJPEG(b []byte) error {
	if len(b) < 4 {
		return errPreviewEmpty
	}
	if b[0] != 0xFF || b[1] != 0xD8 || b[2] != 0xFF || b[len(b)-2] != 0xFF || b[len(b)-1] != 0xD9 {
		return errPreviewFormat
	}
	i := 2
	for i+3 < len(b) {
		if b[i] != 0xFF {
			return errPreviewFormat
		}
		m := b[i+1]
		switch {
		case m == 0xFF: // preenchimento
			i++
			continue
		case m == 0x01 || (m >= 0xD0 && m <= 0xD8): // marcadores sem tamanho
			i += 2
			continue
		case m == 0xD9 || m == 0xDA: // fim ou início dos dados sem ter achado o SOF
			return errPreviewFormat
		}
		segLen := int(b[i+2])<<8 | int(b[i+3])
		if segLen < 2 || i+2+segLen > len(b) {
			return errPreviewFormat
		}
		isSOF := m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC
		if isSOF {
			if segLen < 8 {
				return errPreviewFormat
			}
			h := int(b[i+5])<<8 | int(b[i+6])
			w := int(b[i+7])<<8 | int(b[i+8])
			if w == 0 || h == 0 {
				return errPreviewFormat
			}
			if w > PreviewMaxWidth || h > PreviewMaxHeight {
				return errPreviewSize
			}
			return nil
		}
		i += 2 + segLen
	}
	return errPreviewFormat
}

func (s *Service) previewsEnabled() bool { return s.previews != nil }

// PutScreenPreview guarda a prévia da tela de quem está na chamada do canal (e pode transmitir).
// Limite de um envio a cada PreviewMinInterval por usuário.
func (s *Service) PutScreenPreview(ctx context.Context, userID, channelID int64, data []byte) (err error) {
	if !s.Enabled() {
		return ErrDisabled
	}
	if !s.previewsEnabled() {
		return errPreviewDisabled
	}
	ctx, span := tracer.Start(ctx, "voice.PutScreenPreview", trace.WithAttributes(
		attribute.Int64("channel.id", channelID), attribute.Int("preview.bytes", len(data))))
	defer func() {
		result := "ok"
		switch {
		case err == nil:
		case apperr.IsKind(err, apperr.KindRateLimited):
			result = "rate_limited"
		case apperr.IsKind(err, apperr.KindInvalid):
			result = "invalid"
		case denied(err):
			result = "denied"
		case errors.Is(err, ErrPreviewCapacity) || apperr.IsKind(err, apperr.KindUnavailable):
			result = "capacity"
		default:
			result = "error"
			span.SetStatus(codes.Error, err.Error())
		}
		s.met.previewPuts.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
		span.End()
	}()

	acc, err := s.access.Channel(ctx, userID, channelID)
	if err != nil {
		if denied(err) { // quem não vê o canal não descobre nada sobre ele
			return ErrPreviewNotFound
		}
		return err
	}
	if !acc.Voiceable() {
		return ErrNotVoiceChannel
	}
	if len(data) > PreviewMaxBytes {
		return errPreviewSize
	}
	if err := validateJPEG(data); err != nil {
		return err
	}

	var swept []int64 // indicadores a desligar DEPOIS de soltar a trava deste usuário (as travas são por faixa)
	defer func() { s.clearPreviewFlags(swept) }()
	defer s.lock(userID)()
	st, ok := s.store.Get(userID)
	if !ok || st.ChannelID != channelID {
		return errNotInChannel
	}
	if !st.CanVideo {
		return errNoVideoPerm
	}
	now := s.now()
	if wait := s.previewWait(userID, now); wait > 0 {
		return apperr.RateLimited("envie a prévia com menos frequência", wait)
	}
	p := Preview{
		UserID: userID, ChannelID: channelID, Data: append([]byte(nil), data...), // o corpo é reaproveitado pelo servidor
		ExpiresAt: now.Add(PreviewTTL),
	}
	err = s.previews.Put(p, now)
	if errors.Is(err, ErrPreviewCapacity) { // abre espaço com as vencidas e tenta uma vez mais
		swept = s.previews.Sweep(now)
		err = s.previews.Put(p, now)
	}
	if err != nil {
		if errors.Is(err, ErrPreviewCapacity) {
			return apperr.Unavailable("prévias indisponíveis no momento, tente de novo em instantes")
		}
		return err
	}
	s.markPreviewSent(userID, now)
	s.met.previewBytes.Record(ctx, int64(len(data)))
	if !st.Preview {
		st.Preview = true
		s.store.Put(st)
		s.publish(st, false)
	}
	return nil
}

// DeleteScreenPreview apaga a prévia do usuário (parou de compartilhar ou ocultou). Idempotente.
func (s *Service) DeleteScreenPreview(ctx context.Context, userID int64) error {
	if !s.Enabled() {
		return ErrDisabled
	}
	if !s.previewsEnabled() {
		return nil
	}
	_, span := tracer.Start(ctx, "voice.DeleteScreenPreview")
	defer span.End()
	defer s.lock(userID)()
	s.previews.Delete(userID)
	s.clearPreviewFlag(userID)
	return nil
}

// clearPreviewFlag desliga o indicador de prévia no estado e avisa, se estava ligado. Com a trava do usuário.
func (s *Service) clearPreviewFlag(userID int64) {
	if st, ok := s.store.Get(userID); ok && st.Preview {
		st.Preview = false
		s.store.Put(st)
		s.publish(st, false)
	}
}

// clearPreviewFlags desliga o indicador de cada usuário (sem a trava deles).
func (s *Service) clearPreviewFlags(userIDs []int64) {
	for _, uid := range userIDs {
		func() {
			defer s.lock(uid)()
			s.clearPreviewFlag(uid)
		}()
	}
}

// ScreenPreview devolve o JPEG da prévia de targetID no canal. Quem não vê o canal, e qualquer ausência
// (nunca enviou, ocultou, venceu), recebem 404.
func (s *Service) ScreenPreview(ctx context.Context, viewerID, channelID, targetID int64) (data []byte, err error) {
	if !s.Enabled() {
		return nil, ErrDisabled
	}
	if !s.previewsEnabled() {
		return nil, ErrPreviewNotFound
	}
	ctx, span := tracer.Start(ctx, "voice.ScreenPreview", trace.WithAttributes(attribute.Int64("channel.id", channelID)))
	defer func() {
		result := "hit"
		switch {
		case err == nil:
		case apperr.IsKind(err, apperr.KindNotFound):
			result = "miss"
		default:
			result = "error"
			span.SetStatus(codes.Error, err.Error())
		}
		s.met.previewReads.Add(ctx, 1, metric.WithAttributes(attribute.String("result", result)))
		span.End()
	}()
	acc, err := s.access.Channel(ctx, viewerID, channelID)
	if err != nil {
		if denied(err) {
			return nil, ErrPreviewNotFound
		}
		return nil, err
	}
	if !acc.Voiceable() {
		return nil, ErrPreviewNotFound
	}
	p, ok := s.previews.Get(targetID, channelID, s.now())
	if !ok {
		return nil, ErrPreviewNotFound
	}
	return p.Data, nil
}

// SweepPreviews remove as prévias vencidas e desliga o indicador de quem ficou sem prévia.
func (s *Service) SweepPreviews(ctx context.Context) {
	if !s.Enabled() || !s.previewsEnabled() {
		return
	}
	_, span := tracer.Start(ctx, "voice.SweepPreviews")
	defer span.End()
	now := s.now()
	removed := s.previews.Sweep(now)
	s.clearPreviewFlags(removed)
	s.pruneRate(now)
	span.SetAttributes(attribute.Int("removed", len(removed)))
}

// previewWait diz quanto falta para o usuário poder enviar de novo (0 = já pode).
func (s *Service) previewWait(userID int64, now time.Time) time.Duration {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	if last, ok := s.lastPut[userID]; ok {
		if wait := PreviewMinInterval - now.Sub(last); wait > 0 {
			return wait
		}
	}
	return 0
}

func (s *Service) markPreviewSent(userID int64, now time.Time) {
	s.rateMu.Lock()
	s.lastPut[userID] = now
	s.rateMu.Unlock()
}

func (s *Service) pruneRate(now time.Time) {
	s.rateMu.Lock()
	defer s.rateMu.Unlock()
	for id, t := range s.lastPut {
		if now.Sub(t) > PreviewMinInterval {
			delete(s.lastPut, id)
		}
	}
}
