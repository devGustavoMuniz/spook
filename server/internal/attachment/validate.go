package attachment

import (
	"fmt"
	"net/http"
	"path"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

// allowed é a lista de permissão de tipos (RNF04) com as extensões coerentes com cada um.
// SVG, HTML, executáveis e application/octet-stream ficam de fora de propósito.
var allowed = map[string][]string{
	"image/png":       {"png"},
	"image/jpeg":      {"jpg", "jpeg"},
	"image/gif":       {"gif"},
	"image/webp":      {"webp"},
	"application/pdf": {"pdf"},
	"text/plain":      {"txt", "log", "md", "csv"},
	"application/zip": {"zip"},
	"audio/mpeg":      {"mp3"},
	"audio/ogg":       {"ogg", "oga", "opus"},
	"audio/webm":      {"weba", "webm"},
	"video/mp4":       {"mp4", "m4v"},
	"video/webm":      {"webm"},
}

// sniffed são os tipos cujos primeiros bytes são conferidos no envio da mensagem
// (http.DetectContentType os reconhece pela assinatura).
var sniffed = map[string]bool{
	"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
	"application/pdf": true, "application/zip": true,
}

// SniffLen é quantos bytes iniciais o servidor lê para conferir o tipo.
const SniffLen = 512

// AllowedTypes devolve os tipos aceitos (para mensagens de erro e testes).
func AllowedTypes() []string {
	out := make([]string, 0, len(allowed))
	for t := range allowed {
		out = append(out, t)
	}
	return out
}

// ValidateUpload confere tipo, extensão e tamanho; devolve o nome sanitizado.
func ValidateUpload(filename, contentType string, size int64) (string, error) {
	return ValidateUploadMax(filename, contentType, size, MaxFileSize)
}

// ValidateUploadMax é ValidateUpload com o limite de tamanho configurado (LIMIT_ATTACHMENT_MB).
func ValidateUploadMax(filename, contentType string, size, maxSize int64) (string, error) {
	if size < 1 {
		return "", apperr.Invalid("o arquivo está vazio")
	}
	if size > maxSize {
		return "", apperr.Invalid(fmt.Sprintf("o arquivo passa do limite de %d MB", maxSize>>20))
	}
	exts, ok := allowed[contentType]
	if !ok {
		return "", apperr.Invalid("tipo de arquivo não permitido: " + printable(contentType))
	}
	name, err := SanitizeFilename(filename)
	if err != nil {
		return "", err
	}
	ext := strings.ToLower(strings.TrimPrefix(path.Ext(name), "."))
	for _, e := range exts {
		if e == ext {
			return name, nil
		}
	}
	return "", apperr.Invalid("a extensão do nome não combina com o tipo " + contentType)
}

func printable(s string) string {
	if len(s) > 60 {
		s = s[:60]
	}
	return strings.Map(func(r rune) rune {
		if unicode.IsControl(r) {
			return -1
		}
		return r
	}, s)
}

// SanitizeFilename tira caminho, caracteres de controle e de formatação (inclusive os de inversão de
// direção, usados em "nomes enganosos") e limita a 100 caracteres preservando a extensão.
func SanitizeFilename(name string) (string, error) {
	if i := strings.LastIndexAny(name, `/\`); i >= 0 {
		name = name[i+1:]
	}
	name = strings.Map(func(r rune) rune {
		switch {
		case r == utf8.RuneError, unicode.IsControl(r), unicode.Is(unicode.Cf, r), r == ' ', r == ' ':
			return -1
		case strings.ContainsRune(`<>:"|?*`, r):
			return '_'
		}
		return r
	}, name)
	name = strings.Trim(strings.TrimSpace(name), ". ")
	if name == "" {
		return "", apperr.Invalid("nome de arquivo inválido")
	}
	if r := []rune(name); len(r) > MaxFilenameRunes {
		ext := path.Ext(name)
		extRunes := []rune(ext)
		if len(extRunes) > 16 { // extensão absurda: corta tudo
			extRunes = nil
		}
		keep := MaxFilenameRunes - len(extRunes)
		name = string(r[:keep]) + string(extRunes)
	}
	return name, nil
}

// keySafe deixa o nome seguro para usar numa chave de objeto (só ASCII simples).
func keySafe(name string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9', r == '.', r == '-', r == '_':
			return r
		}
		return '_'
	}, name)
}

// MatchesContent confere os primeiros bytes contra o tipo declarado (só para os tipos de assinatura
// conhecida: imagens, PDF e zip). Os demais passam.
func MatchesContent(declared string, head []byte) bool {
	if !sniffed[declared] {
		return true
	}
	return http.DetectContentType(head) == declared
}

// NeedsSniff diz se o tipo tem os primeiros bytes conferidos.
func NeedsSniff(contentType string) bool { return sniffed[contentType] }
