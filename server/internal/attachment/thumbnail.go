package attachment

import (
	"bytes"
	"errors"
	"fmt"
	"image"
	_ "image/gif" // registra o decodificador de gif
	"image/jpeg"
	"image/png"

	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp" // registra o decodificador de webp
)

// ErrUnprocessable marca imagens que nunca vão virar thumbnail (corrompida, grande demais, formato
// desconhecido): o job é descartado sem retentar e a mensagem segue com o original.
var ErrUnprocessable = errors.New("imagem não processável")

// Thumb é o resultado do redimensionamento.
type Thumb struct {
	Data        []byte
	ContentType string
	Ext         string
	// Largura e altura da imagem ORIGINAL (para o cliente reservar o espaço).
	Width, Height int
}

// MakeThumbnail decodifica a imagem (jpeg, png, gif — primeiro quadro — ou webp), a reduz para caber
// em 400x400 (sem ampliar) e codifica em JPEG q80, ou PNG se houver transparência. As dimensões
// são validadas ANTES de decodificar, para não estourar a memória com uma imagem enorme.
func MakeThumbnail(data []byte) (Thumb, error) {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return Thumb{}, fmt.Errorf("%w: %w", ErrUnprocessable, err)
	}
	if cfg.Width < 1 || cfg.Height < 1 {
		return Thumb{}, fmt.Errorf("%w: dimensões vazias", ErrUnprocessable)
	}
	if cfg.Width > SourceMaxSide || cfg.Height > SourceMaxSide || int64(cfg.Width)*int64(cfg.Height) > SourceMaxPixel {
		return Thumb{}, fmt.Errorf("%w: %dx%d passa do limite", ErrUnprocessable, cfg.Width, cfg.Height)
	}
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return Thumb{}, fmt.Errorf("%w: %w", ErrUnprocessable, err)
	}

	sb := src.Bounds()
	w, h := fit(sb.Dx(), sb.Dy(), ThumbMaxDim)
	dst := image.NewRGBA(image.Rect(0, 0, w, h))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, sb, draw.Src, nil)

	out := Thumb{Width: cfg.Width, Height: cfg.Height}
	var buf bytes.Buffer
	if dst.Opaque() {
		if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: ThumbQuality}); err != nil {
			return Thumb{}, fmt.Errorf("codificar jpeg: %w", err)
		}
		out.ContentType, out.Ext = "image/jpeg", "jpg"
	} else {
		if err := png.Encode(&buf, dst); err != nil {
			return Thumb{}, fmt.Errorf("codificar png: %w", err)
		}
		out.ContentType, out.Ext = "image/png", "png"
	}
	out.Data = buf.Bytes()
	return out, nil
}

// fit calcula o tamanho que cabe em limit x limit mantendo a proporção; nunca amplia.
func fit(w, h, limit int) (int, int) {
	if w <= limit && h <= limit {
		return w, h
	}
	if w >= h {
		nh := int(float64(h) * float64(limit) / float64(w))
		return limit, atLeast1(nh)
	}
	nw := int(float64(w) * float64(limit) / float64(h))
	return atLeast1(nw), limit
}

func atLeast1(n int) int { return max(n, 1) }
