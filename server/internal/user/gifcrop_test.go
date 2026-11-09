package user

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"testing"
)

var testPalette = color.Palette{color.RGBA{A: 0}, color.RGBA{255, 0, 0, 255}, color.RGBA{0, 255, 0, 255}, color.RGBA{0, 0, 255, 255}}

// testGIF cria 3 quadros 40x20: o 1º inteiro vermelho; o 2º só a metade direita verde (quadro parcial,
// disposal "fundo"); o 3º só o quadrado 10x10 do canto superior esquerdo azul (disposal "none").
func testGIF(t *testing.T) []byte {
	t.Helper()
	full := image.Rect(0, 0, 40, 20)
	f1 := image.NewPaletted(full, testPalette)
	draw.Draw(f1, full, image.NewUniform(testPalette[1]), image.Point{}, draw.Src)
	f2 := image.NewPaletted(image.Rect(20, 0, 40, 20), testPalette)
	draw.Draw(f2, f2.Bounds(), image.NewUniform(testPalette[2]), image.Point{}, draw.Src)
	f3 := image.NewPaletted(image.Rect(0, 0, 10, 10), testPalette)
	draw.Draw(f3, f3.Bounds(), image.NewUniform(testPalette[3]), image.Point{}, draw.Src)
	g := &gif.GIF{
		Image:     []*image.Paletted{f1, f2, f3},
		Delay:     []int{7, 8, 9},
		Disposal:  []byte{gif.DisposalNone, gif.DisposalBackground, gif.DisposalNone},
		LoopCount: 3,
		Config:    image.Config{Width: 40, Height: 20, ColorModel: testPalette},
	}
	var b bytes.Buffer
	if err := gif.EncodeAll(&b, g); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func rgbaAt(img image.Image, x, y int) color.RGBA {
	r, g, b, a := img.At(x, y).RGBA()
	return color.RGBA{uint8(r >> 8), uint8(g >> 8), uint8(b >> 8), uint8(a >> 8)}
}

func TestCropGIFPreservesAnimation(t *testing.T) {
	out, err := CropGIF(context.Background(), testGIF(t), image.Rect(0, 0, 20, 20))
	if err != nil {
		t.Fatal(err)
	}
	g, err := gif.DecodeAll(bytes.NewReader(out))
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Image) != 3 || g.LoopCount != 3 {
		t.Fatalf("quadros=%d laço=%d", len(g.Image), g.LoopCount)
	}
	if g.Config.Width != 20 || g.Config.Height != 20 {
		t.Fatalf("tamanho %dx%d", g.Config.Width, g.Config.Height)
	}
	for i, d := range []int{7, 8, 9} {
		if g.Delay[i] != d {
			t.Fatalf("atraso %d = %d", i, g.Delay[i])
		}
	}
	red := color.RGBA{255, 0, 0, 255}
	// O verde do quadro 2 está só na metade direita, fora do recorte: o quadro 2 segue vermelho.
	if rgbaAt(g.Image[0], 5, 5) != red || rgbaAt(g.Image[1], 15, 15) != red {
		t.Fatal("quadros 1 e 2 deveriam ser vermelhos dentro do recorte")
	}
	// Quadro 3: canto 10x10 azul; o resto continua vermelho (o disposal do quadro 2 limpou só a área dele).
	if rgbaAt(g.Image[2], 5, 5) != (color.RGBA{0, 0, 255, 255}) || rgbaAt(g.Image[2], 15, 15) != red {
		t.Fatalf("quadro 3: %v %v", rgbaAt(g.Image[2], 5, 5), rgbaAt(g.Image[2], 15, 15))
	}
}

func TestCropGIFRightHalfSeesPartialFrames(t *testing.T) {
	out, err := CropGIF(context.Background(), testGIF(t), image.Rect(20, 0, 40, 20))
	if err != nil {
		t.Fatal(err)
	}
	g, _ := gif.DecodeAll(bytes.NewReader(out))
	if rgbaAt(g.Image[1], 3, 3) != (color.RGBA{0, 255, 0, 255}) {
		t.Fatal("quadro 2 deveria estar verde na metade direita")
	}
	// Depois do disposal "fundo" do quadro 2, o quadro 3 vê a área limpa (transparente).
	if rgbaAt(g.Image[2], 3, 3).A != 0 {
		t.Fatalf("quadro 3 deveria estar transparente: %v", rgbaAt(g.Image[2], 3, 3))
	}
}

func TestCropGIFWholeImageIsUntouchedAndRectIsClamped(t *testing.T) {
	src := testGIF(t)
	out, err := CropGIF(context.Background(), src, image.Rect(-5, -5, 500, 500))
	if err != nil || !bytes.Equal(out, src) {
		t.Fatalf("recorte que cobre tudo deveria devolver o original: %v", err)
	}
	if _, err := CropGIF(context.Background(), src, image.Rect(100, 100, 120, 120)); err == nil {
		t.Fatal("recorte fora do quadro deveria falhar")
	}
}

func TestCropGIFRejectsGarbageAndLimits(t *testing.T) {
	if _, err := CropGIF(context.Background(), []byte("GIF89a not really"), image.Rect(0, 0, 1, 1)); err == nil {
		t.Fatal("lixo deveria falhar")
	}
	if _, err := CropGIF(context.Background(), []byte("PNG"), image.Rect(0, 0, 1, 1)); err == nil {
		t.Fatal("não-GIF deveria falhar")
	}
	// Cabeçalho legítimo declarando 5000x5000: acima do teto de lado.
	b := testGIF(t)
	b[6], b[7], b[8], b[9] = 0x88, 0x13, 0x88, 0x13
	if _, err := CropGIF(context.Background(), b, image.Rect(0, 0, 10, 10)); !errors.Is(err, ErrGIFTooComplex) {
		t.Fatalf("5000x5000 deveria ser complexo demais: %v", err)
	}
}

type memObjects struct {
	fakeStorage
	objs    map[string][]byte
	deleted []string
}

func (m *memObjects) Get(_ context.Context, k string, _ int64) ([]byte, error) {
	b, ok := m.objs[k]
	if !ok {
		return nil, errors.New("não existe")
	}
	return b, nil
}
func (m *memObjects) Put(_ context.Context, k, _ string, b []byte) error { m.objs[k] = b; return nil }
func (m *memObjects) Delete(_ context.Context, k string) error {
	m.deleted = append(m.deleted, k)
	delete(m.objs, k)
	return nil
}

func TestCropImageService(t *testing.T) {
	st := &memObjects{objs: map[string][]byte{"avatars/7/1.gif": testGIF(t), "avatars/8/1.gif": testGIF(t), "avatars/7/2.png": {1}}}
	svc := NewService(&memStore{u: User{ID: 7}}, st, &seq{n: 100})
	ctx := context.Background()
	rect := image.Rect(0, 0, 20, 20)

	for _, k := range []string{"avatars/8/1.gif", "avatars/7/2.png", "../x.gif", "avatars/7/a/b.gif", "attachments/7/1.gif"} {
		if _, err := svc.CropImage(ctx, 7, k, rect); !errors.Is(err, ErrInvalidAvatar) {
			t.Fatalf("%s deveria ser recusada: %v", k, err)
		}
	}
	key, err := svc.CropImage(ctx, 7, "avatars/7/1.gif", rect)
	if err != nil || key != "avatars/7/101.gif" {
		t.Fatalf("key=%q err=%v", key, err)
	}
	if _, ok := st.objs[key]; !ok || len(st.deleted) != 1 || st.deleted[0] != "avatars/7/1.gif" {
		t.Fatalf("deveria gravar o novo e apagar o original: %v", st.deleted)
	}
	// O mesmo GIF cobrindo tudo mantém a chave.
	st.objs["avatars/7/3.gif"] = testGIF(t)
	if k, err := svc.CropImage(ctx, 7, "avatars/7/3.gif", image.Rect(0, 0, 40, 20)); err != nil || k != "avatars/7/3.gif" {
		t.Fatalf("k=%q err=%v", k, err)
	}
}
