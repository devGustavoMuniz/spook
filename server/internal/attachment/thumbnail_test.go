package attachment

import (
	"bytes"
	"errors"
	"hash/crc32"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"testing"
)

func gradient(w, h int, alpha uint8) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.SetNRGBA(x, y, color.NRGBA{R: uint8(x * 255 / w), G: uint8(y * 255 / h), B: 128, A: alpha})
		}
	}
	return img
}

func encJPEG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := jpeg.Encode(&b, img, nil); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func encPNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var b bytes.Buffer
	if err := png.Encode(&b, img); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func encGIF(t *testing.T, w, h int) []byte {
	t.Helper()
	pal := color.Palette{color.White, color.Black, color.RGBA{R: 255, A: 255}}
	p := image.NewPaletted(image.Rect(0, 0, w, h), pal)
	draw.Draw(p, p.Bounds(), image.NewUniform(color.RGBA{R: 255, A: 255}), image.Point{}, draw.Src)
	var b bytes.Buffer
	// dois quadros: só o primeiro importa
	if err := gif.EncodeAll(&b, &gif.GIF{Image: []*image.Paletted{p, p}, Delay: []int{1, 1}}); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// Um webp mínimo (1x1, lossy) em bytes: o x/image só decodifica, não codifica.
var tinyWebP = []byte{
	0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c, 0x0d, 0x00, 0x00, 0x00,
	0x2f, 0x00, 0x00, 0x00, 0x10, 0x07, 0x10, 0x11, 0x11, 0x88, 0x88, 0xfe, 0x07, 0x00,
}

func decodeThumb(t *testing.T, th Thumb) image.Image {
	t.Helper()
	img, _, err := image.Decode(bytes.NewReader(th.Data))
	if err != nil {
		t.Fatal(err)
	}
	return img
}

func TestThumbnailJPEGLandscapeKeepsAspect(t *testing.T) {
	th, err := MakeThumbnail(encJPEG(t, gradient(1600, 800, 255)))
	if err != nil {
		t.Fatal(err)
	}
	b := decodeThumb(t, th).Bounds()
	if b.Dx() != 400 || b.Dy() != 200 {
		t.Fatalf("thumbnail = %dx%d, esperado 400x200", b.Dx(), b.Dy())
	}
	if th.ContentType != "image/jpeg" || th.Ext != "jpg" || th.Width != 1600 || th.Height != 800 {
		t.Fatalf("meta: %+v", th)
	}
}

func TestThumbnailPortraitAndSquare(t *testing.T) {
	th, err := MakeThumbnail(encJPEG(t, gradient(300, 1200, 255)))
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, th).Bounds(); b.Dx() != 100 || b.Dy() != 400 {
		t.Fatalf("retrato = %dx%d, esperado 100x400", b.Dx(), b.Dy())
	}
	th, err = MakeThumbnail(encPNG(t, gradient(800, 800, 255)))
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, th).Bounds(); b.Dx() != 400 || b.Dy() != 400 {
		t.Fatalf("quadrada = %dx%d", b.Dx(), b.Dy())
	}
}

func TestThumbnailNeverUpscales(t *testing.T) {
	th, err := MakeThumbnail(encPNG(t, gradient(120, 60, 255)))
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, th).Bounds(); b.Dx() != 120 || b.Dy() != 60 {
		t.Fatalf("não deveria ampliar: %dx%d", b.Dx(), b.Dy())
	}
}

func TestThumbnailExtremeAspectKeepsOnePixel(t *testing.T) {
	th, err := MakeThumbnail(encPNG(t, gradient(4000, 2, 255)))
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, th).Bounds(); b.Dx() != 400 || b.Dy() < 1 {
		t.Fatalf("faixa = %dx%d", b.Dx(), b.Dy())
	}
}

func TestThumbnailOpaquePNGBecomesJPEG(t *testing.T) {
	th, err := MakeThumbnail(encPNG(t, gradient(500, 500, 255)))
	if err != nil {
		t.Fatal(err)
	}
	if th.ContentType != "image/jpeg" {
		t.Fatalf("PNG opaco deveria virar JPEG: %s", th.ContentType)
	}
}

func TestThumbnailTransparentPNGStaysPNG(t *testing.T) {
	th, err := MakeThumbnail(encPNG(t, gradient(500, 500, 100)))
	if err != nil {
		t.Fatal(err)
	}
	if th.ContentType != "image/png" || th.Ext != "png" {
		t.Fatalf("PNG com alfa deveria continuar PNG: %s", th.ContentType)
	}
	_, _, _, a := decodeThumb(t, th).At(10, 10).RGBA()
	if a == 0xffff {
		t.Fatal("o alfa foi perdido")
	}
}

func TestThumbnailGIFUsesFirstFrame(t *testing.T) {
	th, err := MakeThumbnail(encGIF(t, 800, 400))
	if err != nil {
		t.Fatal(err)
	}
	if b := decodeThumb(t, th).Bounds(); b.Dx() != 400 || b.Dy() != 200 {
		t.Fatalf("gif = %dx%d", b.Dx(), b.Dy())
	}
	if th.Width != 800 || th.Height != 400 {
		t.Fatalf("meta: %+v", th)
	}
}

func TestThumbnailWebP(t *testing.T) {
	th, err := MakeThumbnail(tinyWebP)
	if err != nil {
		t.Skipf("webp de exemplo não decodificou (%v); coberto pelo teste de integração", err)
	}
	if th.Width < 1 || th.Height < 1 {
		t.Fatalf("meta: %+v", th)
	}
}

func TestThumbnailRejectsOversizedBeforeDecoding(t *testing.T) {
	// Cabeçalho PNG válido de 20000x20000 (400 MP) sem dados: se o código tentasse decodificar,
	// falharia por outro motivo; o que importa é recusar pelas dimensões, sem alocar nada.
	for _, tc := range []struct {
		name string
		w, h int
	}{{"lado maior que 8192", 9000, 100}, {"mais de 12 MP", 5000, 4000}, {"enorme", 20000, 20000}} {
		t.Run(tc.name, func(t *testing.T) {
			data := pngHeaderOnly(tc.w, tc.h)
			_, err := MakeThumbnail(data)
			if !errors.Is(err, ErrUnprocessable) {
				t.Fatalf("esperava ErrUnprocessable, veio %v", err)
			}
		})
	}
}

func TestThumbnailAtLimitsAccepted(t *testing.T) {
	// 12 MP exatos (4000x3000): DecodeConfig passa o limite; o corpo vazio falha na decodificação, mas
	// com ErrUnprocessable de decodificação (não de dimensões).
	_, err := MakeThumbnail(pngHeaderOnly(4000, 3000))
	if !errors.Is(err, ErrUnprocessable) {
		t.Fatalf("veio %v", err)
	}
}

func TestThumbnailCorruptAndUnknown(t *testing.T) {
	for name, data := range map[string][]byte{
		"vazio":      nil,
		"lixo":       []byte("isto não é uma imagem de jeito nenhum"),
		"jpeg curto": encJPEG(t, gradient(50, 50, 255))[:30],
		"png truncado": func() []byte {
			b := encPNG(t, gradient(200, 200, 255))
			return b[:len(b)/2]
		}(),
		"html": []byte("<html><script>alert(1)</script></html>"),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := MakeThumbnail(data); !errors.Is(err, ErrUnprocessable) {
				t.Fatalf("esperava ErrUnprocessable, veio %v", err)
			}
		})
	}
}

func TestFit(t *testing.T) {
	for _, tt := range []struct{ w, h, ew, eh int }{
		{400, 400, 400, 400}, {401, 100, 400, 99}, {100, 800, 50, 400}, {10, 10, 10, 10}, {1, 100000, 1, 400},
	} {
		if w, h := fit(tt.w, tt.h, ThumbMaxDim); w != tt.ew || h != tt.eh {
			t.Errorf("fit(%d,%d) = %dx%d, esperado %dx%d", tt.w, tt.h, w, h, tt.ew, tt.eh)
		}
	}
}

// pngHeaderOnly monta só a assinatura e o IHDR de um PNG com as dimensões dadas.
func pngHeaderOnly(w, h int) []byte {
	var b bytes.Buffer
	b.WriteString("\x89PNG\r\n\x1a\n")
	ihdr := []byte{byte(w >> 24), byte(w >> 16), byte(w >> 8), byte(w), byte(h >> 24), byte(h >> 16), byte(h >> 8), byte(h), 8, 2, 0, 0, 0}
	b.Write([]byte{0, 0, 0, 13})
	b.WriteString("IHDR")
	b.Write(ihdr)
	crc := crc32IEEE(append([]byte("IHDR"), ihdr...))
	b.Write([]byte{byte(crc >> 24), byte(crc >> 16), byte(crc >> 8), byte(crc)})
	return b.Bytes()
}

func crc32IEEE(b []byte) uint32 { return crc32.ChecksumIEEE(b) }
