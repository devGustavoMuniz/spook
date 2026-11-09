package user

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"image"
	"net/mail"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/devGustavoMuniz/spook/server/internal/platform/events"
)

// Store é o que o service precisa do banco.
type Store interface {
	Create(ctx context.Context, id int64, email, username, passwordHash string) (User, error)
	ByID(ctx context.Context, id int64) (User, error)
	ByEmail(ctx context.Context, email string) (User, string, error)
	UpdateProfile(ctx context.Context, id int64, p ProfileFields) (User, error)
	UpdateEmail(ctx context.Context, id int64, email string) (User, error)
	PasswordHash(ctx context.Context, id int64) (string, error)
	SetPasswordHash(ctx context.Context, id int64, hash string) error
}

// AvatarStorage é o que o service precisa do storage S3 (URLs pré-assinadas).
type AvatarStorage interface {
	PresignPut(ctx context.Context, key, contentType string, size int64, ttl time.Duration) (string, error)
	PresignGet(ctx context.Context, key string, ttl time.Duration) (string, error)
	// Get, Put e Delete servem ao recorte de GIF no servidor (CropImage).
	Get(ctx context.Context, key string, maxBytes int64) ([]byte, error)
	Put(ctx context.Context, key, contentType string, data []byte) error
	Delete(ctx context.Context, key string) error
}

type IDGenerator interface{ Next() int64 }

const (
	MaxAvatarBytes = 5 << 20
	avatarPutTTL   = 5 * time.Minute
	avatarGetTTL   = time.Hour
)

// imageTypes vale para avatar e banner. GIF e WebP animados são aceitos e guardados como enviados (o
// upload vai direto ao S3, sem reprocessamento), então a animação é preservada. O limite é o mesmo de 5 MB.
var imageTypes = map[string]string{"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}

type Service struct {
	store   Store
	storage AvatarStorage // pode ser nil: avatar desativado
	ids     IDGenerator
	// pub e aud publicam USER_UPDATE quando o perfil muda (nulos = não publica; testes e ferramentas).
	pub events.Publisher
	aud Audience
	// verifier é o ponto de extensão da troca de e-mail com verificação (nulo = troca direta).
	verifier EmailChangeVerifier
}

func NewService(store Store, storage AvatarStorage, ids IDGenerator) *Service {
	return &Service{store: store, storage: storage, ids: ids}
}

func (s *Service) Create(ctx context.Context, email, username, passwordHash string) (User, error) {
	if IsReservedUsername(username) {
		return User{}, ErrReservedUsername
	}
	return s.store.Create(ctx, s.ids.Next(), strings.TrimSpace(email), username, passwordHash)
}

func (s *Service) Get(ctx context.Context, id int64) (User, error) { return s.store.ByID(ctx, id) }

// NoPassword é o marcador em password_hash das contas sem senha (criadas por login social, ou excluídas).
// Nenhum hash argon2 válido é igual a ele, então a verificação de senha sempre falha.
const NoPassword = "!"

// ByEmail devolve a conta ativa com esse e-mail (ErrNotFound se não houver).
func (s *Service) ByEmail(ctx context.Context, email string) (User, error) {
	u, _, err := s.store.ByEmail(ctx, strings.TrimSpace(email))
	return u, err
}

// Credentials devolve o usuário e o hash da senha, para o login (pacote auth).
func (s *Service) Credentials(ctx context.Context, email string) (User, string, error) {
	return s.store.ByEmail(ctx, strings.TrimSpace(email))
}

// ProfileFields são os campos de perfil como ficam gravados (o service já mesclou com o atual).
type ProfileFields struct {
	DisplayName *string
	AvatarKey   *string
	Bio         *string
	Pronouns    *string
	BannerKey   *string
	BannerColor *int32
}

const (
	MaxBioRunes      = 190
	MaxPronounsRunes = 40
	maxEmailLen      = 254
)

type ProfileUpdate struct {
	DisplayName  *string // nil = não altera; "" = remove
	AvatarKey    *string // nil = não altera
	RemoveAvatar bool
	Bio          *string // nil = não altera; "" = remove
	Pronouns     *string // nil = não altera; "" = remove
	// Banner: imagem OU cor. Definir um limpa o outro; RemoveBanner limpa os dois.
	BannerKey    *string
	BannerColor  *int32
	RemoveBanner bool
}

// cleanText apara espaços, tira caracteres de controle (menos \n quando allowNewline) e valida o tamanho em runes.
func cleanText(in string, max int, allowNewline bool) (*string, bool) {
	var b strings.Builder
	for _, r := range strings.TrimSpace(in) {
		switch {
		case r == '\n' && allowNewline:
			b.WriteRune(r)
		case r == '\r':
		case unicode.IsControl(r):
		default:
			b.WriteRune(r)
		}
	}
	out := strings.TrimSpace(b.String())
	if utf8.RuneCountInString(out) > max {
		return nil, false
	}
	if out == "" {
		return nil, true
	}
	return &out, true
}

func (s *Service) UpdateProfile(ctx context.Context, id int64, in ProfileUpdate) (User, error) {
	cur, err := s.store.ByID(ctx, id)
	if err != nil {
		return User{}, err
	}
	p := ProfileFields{
		DisplayName: cur.DisplayName, AvatarKey: cur.AvatarKey, Bio: cur.Bio, Pronouns: cur.Pronouns,
		BannerKey: cur.BannerKey, BannerColor: cur.BannerColor,
	}

	if in.DisplayName != nil {
		name := strings.TrimSpace(*in.DisplayName)
		if name == "" {
			p.DisplayName = nil
		} else {
			p.DisplayName = &name
		}
	}
	if in.Bio != nil {
		v, ok := cleanText(*in.Bio, MaxBioRunes, true)
		if !ok {
			return User{}, ErrInvalidProfile
		}
		p.Bio = v
	}
	if in.Pronouns != nil {
		v, ok := cleanText(*in.Pronouns, MaxPronounsRunes, false)
		if !ok {
			return User{}, ErrInvalidProfile
		}
		p.Pronouns = v
	}
	switch {
	case in.RemoveAvatar:
		p.AvatarKey = nil
	case in.AvatarKey != nil:
		// O cliente só pode apontar para chaves geradas para ele em RequestAvatarUpload.
		if !strings.HasPrefix(*in.AvatarKey, avatarPrefix(id)) {
			return User{}, ErrInvalidAvatar
		}
		p.AvatarKey = in.AvatarKey
	}
	if in.BannerKey != nil && in.BannerColor != nil {
		return User{}, ErrInvalidBanner // imagem OU cor
	}
	switch {
	case in.RemoveBanner:
		p.BannerKey, p.BannerColor = nil, nil
	case in.BannerKey != nil:
		if !strings.HasPrefix(*in.BannerKey, bannerPrefix(id)) {
			return User{}, ErrInvalidBanner
		}
		p.BannerKey, p.BannerColor = in.BannerKey, nil
	case in.BannerColor != nil:
		if *in.BannerColor < 0 || *in.BannerColor > 0xFFFFFF {
			return User{}, ErrInvalidBanner
		}
		p.BannerKey, p.BannerColor = nil, in.BannerColor
	}
	u, err := s.store.UpdateProfile(ctx, id, p)
	if err != nil {
		return User{}, err
	}
	s.publishUpdate(ctx, u)
	return u, nil
}

// EmailChangeVerifier é o ponto de extensão da verificação por e-mail (lote futuro: confirmar no
// endereço novo antes de trocar). Nulo (padrão) = a troca é direta. Se Begin devolver apply=false, a
// troca fica pendente e o service responde ErrEmailVerificationPending sem alterar a conta.
type EmailChangeVerifier interface {
	Begin(ctx context.Context, userID int64, newEmail string) (apply bool, err error)
}

// SetEmailChangeVerifier liga o verificador (nil desliga).
func (s *Service) SetEmailChangeVerifier(v EmailChangeVerifier) { s.verifier = v }

// ChangeEmail troca o e-mail. A confirmação recente de senha é exigida pela camada HTTP.
func (s *Service) ChangeEmail(ctx context.Context, id int64, email string) (User, error) {
	email = strings.TrimSpace(email)
	addr, err := mail.ParseAddress(email)
	if err != nil || addr.Address != email || len(email) > maxEmailLen || !strings.Contains(email[strings.LastIndex(email, "@"):], ".") {
		return User{}, ErrInvalidEmail
	}
	cur, err := s.store.ByID(ctx, id)
	if err != nil {
		return User{}, err
	}
	if strings.EqualFold(cur.Email, email) && cur.Email == email {
		return cur, nil
	}
	if s.verifier != nil {
		apply, err := s.verifier.Begin(ctx, id, email)
		if err != nil {
			return User{}, err
		}
		if !apply {
			// A conta não muda; devolve-se o estado atual (com pending_email) junto do erro.
			fresh, gerr := s.store.ByID(ctx, id)
			if gerr != nil {
				return User{}, gerr
			}
			return fresh, ErrEmailVerificationPending
		}
	}
	return s.store.UpdateEmail(ctx, id, email)
}

// PasswordHash e SetPasswordHash servem ao pacote auth (trocar senha, confirmar senha, excluir conta).
func (s *Service) PasswordHash(ctx context.Context, id int64) (string, error) {
	return s.store.PasswordHash(ctx, id)
}

func (s *Service) SetPasswordHash(ctx context.Context, id int64, hash string) error {
	return s.store.SetPasswordHash(ctx, id, hash)
}

type AvatarUpload struct {
	URL string
	Key string
}

// RequestAvatarUpload devolve uma URL pré-assinada para o cliente enviar o avatar direto ao storage.
func (s *Service) RequestAvatarUpload(ctx context.Context, userID int64, contentType string, size int64) (AvatarUpload, error) {
	up, err := s.requestImageUpload(ctx, avatarPrefix(userID), contentType, size)
	if errors.Is(err, errInvalidImage) {
		return AvatarUpload{}, ErrInvalidAvatar
	}
	return up, err
}

// RequestBannerUpload é o equivalente do avatar para o banner do perfil.
func (s *Service) RequestBannerUpload(ctx context.Context, userID int64, contentType string, size int64) (AvatarUpload, error) {
	up, err := s.requestImageUpload(ctx, bannerPrefix(userID), contentType, size)
	if errors.Is(err, errInvalidImage) {
		return AvatarUpload{}, ErrInvalidBanner
	}
	return up, err
}

var errInvalidImage = errors.New("imagem inválida")

func (s *Service) requestImageUpload(ctx context.Context, prefix, contentType string, size int64) (AvatarUpload, error) {
	if s.storage == nil {
		return AvatarUpload{}, fmt.Errorf("storage não configurado")
	}
	ext, ok := imageTypes[contentType]
	if !ok || size <= 0 || size > MaxAvatarBytes {
		return AvatarUpload{}, errInvalidImage
	}
	key := fmt.Sprintf("%s%d.%s", prefix, s.ids.Next(), ext)
	url, err := s.storage.PresignPut(ctx, key, contentType, size, avatarPutTTL)
	if err != nil {
		return AvatarUpload{}, err
	}
	return AvatarUpload{URL: url, Key: key}, nil
}

// AvatarURL devolve uma URL de leitura temporária, ou "" se não houver avatar.
func (s *Service) AvatarURL(ctx context.Context, u User) string {
	if s.storage == nil || u.AvatarKey == nil {
		return ""
	}
	url, err := s.storage.PresignGet(ctx, *u.AvatarKey, avatarGetTTL)
	if err != nil {
		return ""
	}
	return url
}

func avatarPrefix(userID int64) string { return fmt.Sprintf("avatars/%d/", userID) }
func bannerPrefix(userID int64) string { return fmt.Sprintf("banners/%d/", userID) }

// AvatarURLForKey devolve a URL de leitura de uma chave de avatar, ou "" se não houver.
func (s *Service) AvatarURLForKey(ctx context.Context, key *string) string {
	return s.AvatarURL(ctx, User{AvatarKey: key})
}

// CropImage recorta, no servidor, um GIF que o usuário já enviou por URL pré-assinada (avatar ou banner dele) e
// grava o resultado numa chave nova do mesmo prefixo; o original é apagado. Só GIF passa por aqui: PNG, JPEG e
// WebP estáticos são recortados no navegador, e WebP/APNG animados são usados como estão. Devolve
// ErrInvalidAvatar para chave que não é do usuário ou não é .gif, ErrGIFTooComplex acima dos limites.
func (s *Service) CropImage(ctx context.Context, userID int64, key string, rect image.Rectangle) (string, error) {
	if s.storage == nil {
		return "", fmt.Errorf("storage não configurado")
	}
	var prefix string
	switch {
	case strings.HasPrefix(key, avatarPrefix(userID)):
		prefix = avatarPrefix(userID)
	case strings.HasPrefix(key, bannerPrefix(userID)):
		prefix = bannerPrefix(userID)
	default:
		return "", ErrInvalidAvatar
	}
	if !strings.HasSuffix(key, ".gif") || strings.Contains(key[len(prefix):], "/") {
		return "", ErrInvalidAvatar
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	select {
	case cropSlots <- struct{}{}:
		defer func() { <-cropSlots }()
	case <-ctx.Done():
		return "", ctx.Err()
	}
	data, err := s.storage.Get(ctx, key, MaxAvatarBytes)
	if err != nil {
		return "", ErrInvalidAvatar
	}
	cropped, err := CropGIF(ctx, data, rect)
	if err != nil {
		if errors.Is(err, ErrGIFTooComplex) {
			return "", err
		}
		return "", fmt.Errorf("%w: %w", ErrInvalidAvatar, err)
	}
	if len(cropped) > MaxAvatarBytes {
		return "", ErrGIFTooComplex
	}
	if bytes.Equal(cropped, data) {
		return key, nil
	}
	newKey := fmt.Sprintf("%s%d.gif", prefix, s.ids.Next())
	if err := s.storage.Put(ctx, newKey, "image/gif", cropped); err != nil {
		return "", err
	}
	_ = s.storage.Delete(ctx, key) // o original não é mais necessário; falha aqui só deixa um objeto órfão
	return newKey, nil
}

// cropSlots limita os recortes simultâneos (cada um pode ocupar dezenas de MB).
var cropSlots = make(chan struct{}, 2)
