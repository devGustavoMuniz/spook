package attachment

import (
	"bytes"
	"strings"
	"testing"

	"github.com/devGustavoMuniz/spook/server/internal/platform/apperr"
)

func TestValidateUpload(t *testing.T) {
	tests := []struct {
		name, filename, ct string
		size               int64
		wantName           string // vazio = esperava erro
	}{
		{"png", "foto.png", "image/png", 1000, "foto.png"},
		{"jpeg com .jpg", "foto.JPG", "image/jpeg", 1000, "foto.JPG"},
		{"jpeg com .jpeg", "foto.jpeg", "image/jpeg", 1, "foto.jpeg"},
		{"gif", "a.gif", "image/gif", 10, "a.gif"},
		{"webp", "a.webp", "image/webp", 10, "a.webp"},
		{"pdf", "doc.pdf", "application/pdf", 10, "doc.pdf"},
		{"texto", "notas.txt", "text/plain", 10, "notas.txt"},
		{"zip", "a.zip", "application/zip", 10, "a.zip"},
		{"mp3", "a.mp3", "audio/mpeg", 10, "a.mp3"},
		{"ogg", "a.ogg", "audio/ogg", 10, "a.ogg"},
		{"audio webm", "a.webm", "audio/webm", 10, "a.webm"},
		{"mp4", "a.mp4", "video/mp4", 10, "a.mp4"},
		{"video webm", "a.webm", "video/webm", 10, "a.webm"},
		{"25 MB exatos", "a.zip", "application/zip", MaxFileSize, "a.zip"},
		{"acima de 25 MB", "a.zip", "application/zip", MaxFileSize + 1, ""},
		{"vazio", "a.zip", "application/zip", 0, ""},
		{"negativo", "a.zip", "application/zip", -5, ""},
		{"svg", "a.svg", "image/svg+xml", 10, ""},
		{"html", "a.html", "text/html", 10, ""},
		{"octet-stream", "a.bin", "application/octet-stream", 10, ""},
		{"executável", "a.exe", "application/x-msdownload", 10, ""},
		{"javascript", "a.js", "text/javascript", 10, ""},
		{"tipo com parâmetro", "a.txt", "text/plain; charset=utf-8", 10, ""},
		{"tipo em maiúsculas", "a.png", "IMAGE/PNG", 10, ""},
		{"tipo vazio", "a.png", "", 10, ""},
		{"extensão errada para o tipo", "a.exe", "image/png", 10, ""},
		{"html disfarçado de png", "a.html", "image/png", 10, ""},
		{"sem extensão", "arquivo", "image/png", 10, ""},
		{"extensão dupla ok", "a.tar.zip", "application/zip", 10, "a.tar.zip"},
		{"caminho removido", "../../etc/passwd.txt", "text/plain", 10, "passwd.txt"},
		{"nome vazio", "", "text/plain", 10, ""},
		{"só pontos", "...", "text/plain", 10, ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := ValidateUpload(tt.filename, tt.ct, tt.size)
			if tt.wantName == "" {
				if !apperr.IsKind(err, apperr.KindInvalid) {
					t.Fatalf("esperava 422, veio nome=%q err=%v", got, err)
				}
				return
			}
			if err != nil || got != tt.wantName {
				t.Fatalf("nome=%q err=%v, esperado %q", got, err, tt.wantName)
			}
		})
	}
}

func TestSizeMessagesAreClear(t *testing.T) {
	_, err := ValidateUpload("a.zip", "application/zip", MaxFileSize+1)
	if err == nil || !strings.Contains(err.Error(), "25 MB") {
		t.Fatalf("a mensagem deveria citar o limite: %v", err)
	}
}

func TestSanitizeFilename(t *testing.T) {
	long := strings.Repeat("a", 300) + ".png"
	tests := []struct{ in, want string }{
		{"foto.png", "foto.png"},
		{"C:\\Users\\x\\foto.png", "foto.png"},
		{"/etc/passwd", "passwd"},
		{"a/b/c.txt", "c.txt"},
		{"..\\..\\x.txt", "x.txt"},
		{"nome\x00com\x01controle\n.txt", "nomecomcontrole.txt"},
		{"  espaços  .txt  ", "espaços  .txt"},
		{".oculto", "oculto"},
		{"a<b>c:d\"e|f?g*h.txt", "a_b_c_d_e_f_g_h.txt"},
		{"relatório final – ç.pdf", "relatório final – ç.pdf"},
		{"evil\u202Egnp.exe", "evilgnp.exe"}, // inversão de direção removida
		{"zero\u200Bwidth.txt", "zerowidth.txt"},
		{"emoji 😀.png", "emoji 😀.png"},
	}
	for _, tt := range tests {
		got, err := SanitizeFilename(tt.in)
		if err != nil || got != tt.want {
			t.Errorf("SanitizeFilename(%q) = %q, %v; esperado %q", tt.in, got, err, tt.want)
		}
	}
	got, err := SanitizeFilename(long)
	if err != nil || len([]rune(got)) != MaxFilenameRunes || !strings.HasSuffix(got, ".png") {
		t.Fatalf("nome longo: %d runes, %q, %v", len([]rune(got)), got[len(got)-10:], err)
	}
	for _, bad := range []string{"", "   ", "...", "/", "\x00\x01", "\u202E"} {
		if _, err := SanitizeFilename(bad); err == nil {
			t.Errorf("%q deveria ser recusado", bad)
		}
	}
}

func TestKeySafe(t *testing.T) {
	if got := keySafe("relatório final #1+2.pdf"); got != "relat_rio_final__1_2.pdf" {
		t.Fatalf("keySafe = %q", got)
	}
}

func TestMatchesContent(t *testing.T) {
	png := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	jpg := []byte("\xff\xd8\xff\xe0\x00\x10JFIF")
	gif := []byte("GIF89a\x01\x00\x01\x00")
	webp := []byte("RIFF\x24\x00\x00\x00WEBPVP8 ")
	pdf := []byte("%PDF-1.7\n")
	zip := []byte("PK\x03\x04\x14\x00")
	html := []byte("<!DOCTYPE html><html><script>alert(1)</script>")
	exe := []byte("MZ\x90\x00\x03")
	tests := []struct {
		declared string
		head     []byte
		want     bool
	}{
		{"image/png", png, true}, {"image/jpeg", jpg, true}, {"image/gif", gif, true}, {"image/webp", webp, true},
		{"application/pdf", pdf, true}, {"application/zip", zip, true},
		{"image/png", jpg, false}, {"image/png", html, false}, {"image/jpeg", png, false},
		{"application/pdf", zip, false}, {"application/zip", exe, false}, {"image/gif", bytes.Repeat([]byte{0}, 20), false},
		{"image/png", nil, false},
		// sem assinatura conhecida: não confere
		{"text/plain", html, true}, {"audio/mpeg", exe, true}, {"video/mp4", html, true},
	}
	for _, tt := range tests {
		if got := MatchesContent(tt.declared, tt.head); got != tt.want {
			t.Errorf("MatchesContent(%s, %q) = %v, esperado %v", tt.declared, tt.head, got, tt.want)
		}
	}
}

func TestEveryAllowedTypeHasExtensions(t *testing.T) {
	for _, ct := range AllowedTypes() {
		if len(allowed[ct]) == 0 {
			t.Errorf("%s sem extensões", ct)
		}
	}
	for _, banned := range []string{"image/svg+xml", "text/html", "application/octet-stream", "application/x-msdownload"} {
		if _, ok := allowed[banned]; ok {
			t.Errorf("%s não pode estar na lista de permissão", banned)
		}
	}
}
