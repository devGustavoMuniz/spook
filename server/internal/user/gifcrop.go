package user

import (
	"bytes"
	"context"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
)

// Limites do recorte de GIF (defesa contra arquivos pequenos que expandem muito na decodificação).
const (
	gifMaxSide   = 4096      // maior lado do quadro lógico
	gifMaxFrames = 500       // quadros
	gifMaxVolume = 100 << 20 // largura x altura x quadros (pixels paletados decodificados)
)

var (
	// ErrGIFTooComplex: o GIF passa dos limites de recorte (o cliente usa o arquivo original).
	ErrGIFTooComplex = errors.New("gif complexo demais para recortar")
	errNotGIF        = errors.New("não é um gif válido")
)

// gifFrameCount percorre a estrutura do GIF (sem decodificar o LZW) e conta os quadros. Rejeita estrutura
// truncada. Serve para recusar antes de alocar.
func gifFrameCount(b []byte) (int, error) {
	if len(b) < 13 || (string(b[:6]) != "GIF87a" && string(b[:6]) != "GIF89a") {
		return 0, errNotGIF
	}
	i := 13
	if b[10]&0x80 != 0 {
		i += 3 * (1 << (int(b[10]&7) + 1))
	}
	skipSub := func() bool {
		for i < len(b) {
			n := int(b[i])
			i++
			if n == 0 {
				return true
			}
			i += n
		}
		return false
	}
	frames := 0
	for i < len(b) {
		switch b[i] {
		case 0x3B:
			return frames, nil
		case 0x21:
			i += 2
			if !skipSub() {
				return 0, errNotGIF
			}
		case 0x2C:
			frames++
			if frames > gifMaxFrames {
				return 0, ErrGIFTooComplex
			}
			if i+10 > len(b) {
				return 0, errNotGIF
			}
			packed := b[i+9]
			i += 10
			if packed&0x80 != 0 {
				i += 3 * (1 << (int(packed&7) + 1))
			}
			i++ // tamanho mínimo do LZW
			if !skipSub() {
				return 0, errNotGIF
			}
		default:
			return 0, errNotGIF
		}
	}
	return 0, errNotGIF
}

// CropGIF recorta um GIF (animado ou não) para r, em pixels do quadro lógico, preservando animação, atrasos e
// laço. Os quadros são compostos (respeitando disposal), recortados e regravados com a paleta do próprio quadro,
// sem redimensionar: as cores continuam as do original. r é limitado ao quadro; r vazio ou igual ao quadro
// inteiro devolve os bytes originais.
func CropGIF(ctx context.Context, data []byte, r image.Rectangle) ([]byte, error) {
	frames, err := gifFrameCount(data)
	if err != nil {
		return nil, err
	}
	cfg, err := gif.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, errNotGIF
	}
	if cfg.Width <= 0 || cfg.Height <= 0 || cfg.Width > gifMaxSide || cfg.Height > gifMaxSide ||
		cfg.Width*cfg.Height*max(frames, 1) > gifMaxVolume {
		return nil, ErrGIFTooComplex
	}
	bounds := image.Rect(0, 0, cfg.Width, cfg.Height)
	r = r.Canon().Intersect(bounds)
	if r.Empty() {
		return nil, errNotGIF
	}
	if r == bounds {
		return data, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	g, err := gif.DecodeAll(bytes.NewReader(data))
	if err != nil {
		return nil, errNotGIF
	}

	canvas := image.NewRGBA(bounds)
	out := &gif.GIF{LoopCount: g.LoopCount, Config: image.Config{Width: r.Dx(), Height: r.Dy()}}
	for i, frame := range g.Image {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var prev *image.RGBA
		disposal := byte(0)
		if i < len(g.Disposal) {
			disposal = g.Disposal[i]
		}
		if disposal == gif.DisposalPrevious {
			prev = image.NewRGBA(bounds)
			copy(prev.Pix, canvas.Pix)
		}
		draw.Draw(canvas, frame.Bounds(), frame, frame.Bounds().Min, draw.Over)

		pal := withTransparent(frame.Palette)
		cropped := image.NewPaletted(image.Rect(0, 0, r.Dx(), r.Dy()), pal)
		draw.Draw(cropped, cropped.Bounds(), canvas, r.Min, draw.Src)
		out.Image = append(out.Image, cropped)
		out.Disposal = append(out.Disposal, gif.DisposalNone)
		if i < len(g.Delay) {
			out.Delay = append(out.Delay, g.Delay[i])
		} else {
			out.Delay = append(out.Delay, 0)
		}

		switch disposal {
		case gif.DisposalBackground:
			draw.Draw(canvas, frame.Bounds(), image.Transparent, image.Point{}, draw.Src)
		case gif.DisposalPrevious:
			copy(canvas.Pix, prev.Pix)
		}
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, out); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// withTransparent garante uma entrada transparente na paleta (se couber), para as áreas ainda sem pintura.
func withTransparent(p color.Palette) color.Palette {
	for _, c := range p {
		if _, _, _, a := c.RGBA(); a == 0 {
			return p
		}
	}
	if len(p) < 256 {
		np := make(color.Palette, len(p), len(p)+1)
		copy(np, p)
		return append(np, color.RGBA{})
	}
	return p
}
