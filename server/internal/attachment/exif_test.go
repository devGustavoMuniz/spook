package attachment

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"testing"
)

var (
	red    = color.RGBA{220, 30, 30, 255}
	green  = color.RGBA{30, 200, 30, 255}
	blue   = color.RGBA{30, 30, 220, 255}
	yellow = color.RGBA{230, 230, 30, 255}
)

// quadrantJPEG gera um JPEG 32x16 com 4 quadrantes de cores distintas (TL vermelho, TR verde, BL azul, BR amarelo)
// e, se orientation > 0, insere um segmento EXIF com a orientação logo depois do SOI.
func quadrantJPEG(t *testing.T, orientation int, bigEndian bool) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 32, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 32; x++ {
			c := red
			switch {
			case x >= 16 && y < 8:
				c = green
			case x < 16 && y >= 8:
				c = blue
			case x >= 16 && y >= 8:
				c = yellow
			}
			img.Set(x, y, c)
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	raw := buf.Bytes()
	if orientation == 0 {
		return raw
	}
	var bo binary.AppendByteOrder = binary.LittleEndian
	order := "II"
	if bigEndian {
		bo, order = binary.BigEndian, "MM"
	}
	tiff := []byte(order)
	tiff = bo.AppendUint16(tiff, 42)
	tiff = bo.AppendUint32(tiff, 8) // IFD0 logo depois do cabeçalho
	tiff = bo.AppendUint16(tiff, 1) // 1 entrada
	tiff = bo.AppendUint16(tiff, 0x0112)
	tiff = bo.AppendUint16(tiff, 3) // SHORT
	tiff = bo.AppendUint32(tiff, 1)
	tiff = bo.AppendUint16(tiff, uint16(orientation))
	tiff = append(tiff, 0, 0)       // preenchimento do campo de valor
	tiff = bo.AppendUint32(tiff, 0) // sem próximo IFD
	seg := append([]byte("Exif\x00\x00"), tiff...)
	app1 := []byte{0xFF, 0xE1}
	app1 = binary.BigEndian.AppendUint16(app1, uint16(len(seg)+2))
	app1 = append(app1, seg...)
	return append(append(append([]byte{}, raw[:2]...), app1...), raw[2:]...)
}

func near(a, b color.RGBA) bool {
	d := func(x, y uint8) int {
		if x > y {
			return int(x - y)
		}
		return int(y - x)
	}
	return d(a.R, b.R) < 45 && d(a.G, b.G) < 45 && d(a.B, b.B) < 45
}

func corner(t *testing.T, img image.Image, x, y int) color.RGBA {
	t.Helper()
	r, g, b, _ := img.At(x, y).RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), 255}
}

func TestThumbnailAppliesExifOrientation(t *testing.T) {
	// canto de origem que cai em [TL, TR, BR, BL] da imagem de saída, para cada orientação (semântica do EXIF)
	want := map[int][4]color.RGBA{
		1: {red, green, yellow, blue},
		2: {green, red, blue, yellow},
		3: {yellow, blue, red, green},
		4: {blue, yellow, green, red},
		5: {red, blue, yellow, green},
		6: {blue, red, green, yellow},
		7: {yellow, green, red, blue},
		8: {green, yellow, blue, red},
	}
	for o := 1; o <= 8; o++ {
		for _, be := range []bool{false, true} {
			th, err := MakeThumbnail(quadrantJPEG(t, o, be))
			if err != nil {
				t.Fatalf("orientação %d: %v", o, err)
			}
			img, _, err := image.Decode(bytes.NewReader(th.Data))
			if err != nil {
				t.Fatal(err)
			}
			b := img.Bounds()
			wantW, wantH := 32, 16
			if o >= 5 {
				wantW, wantH = 16, 32
			}
			if b.Dx() != wantW || b.Dy() != wantH || th.Width != wantW || th.Height != wantH {
				t.Fatalf("orientação %d: thumb %dx%d, width/height %dx%d, esperado %dx%d", o, b.Dx(), b.Dy(), th.Width, th.Height, wantW, wantH)
			}
			got := [4]color.RGBA{
				corner(t, img, 2, 2), corner(t, img, b.Dx()-3, 2),
				corner(t, img, b.Dx()-3, b.Dy()-3), corner(t, img, 2, b.Dy()-3),
			}
			for i := range got {
				if !near(got[i], want[o][i]) {
					t.Fatalf("orientação %d (big-endian=%v): canto %d = %v, esperado %v", o, be, i, got[i], want[o][i])
				}
			}
		}
	}
}

func TestJPEGWithoutOrMalformedExifKeepsOrientation1(t *testing.T) {
	good := quadrantJPEG(t, 6, false)
	cases := map[string][]byte{
		"sem EXIF":          quadrantJPEG(t, 0, false),
		"vazio":             nil,
		"não é JPEG":        []byte("GIF89a......"),
		"EXIF truncado":     good[:20],
		"valor fora de 1-8": quadrantJPEG(t, 9, false),
	}
	for name, data := range cases {
		if o := jpegOrientation(data); o != 1 {
			t.Errorf("%s: orientação = %d, esperado 1", name, o)
		}
	}
	if o := jpegOrientation(good); o != 6 {
		t.Errorf("EXIF válido: orientação = %d, esperado 6", o)
	}
}

func TestPNGIsNotReoriented(t *testing.T) {
	img := image.NewRGBA(image.Rect(0, 0, 20, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 20; x++ {
			img.Set(x, y, red)
		}
	}
	var buf bytes.Buffer
	if err := pngEncode(&buf, img); err != nil {
		t.Fatal(err)
	}
	th, err := MakeThumbnail(buf.Bytes())
	if err != nil || th.Width != 20 || th.Height != 10 {
		t.Fatalf("PNG deveria manter 20x10: %+v err=%v", th, err)
	}
}

func pngEncode(buf *bytes.Buffer, img image.Image) error { return png.Encode(buf, img) }
