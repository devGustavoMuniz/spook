package user

import (
	"bytes"
	"encoding/binary"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"testing"
)

func gifBytes(t *testing.T, frames int) []byte {
	t.Helper()
	g := &gif.GIF{}
	for i := 0; i < frames; i++ {
		g.Image = append(g.Image, image.NewPaletted(image.Rect(0, 0, 4, 4), color.Palette{color.Black, color.White}))
		g.Delay = append(g.Delay, 5)
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, g); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func pngChunk(typ string, data []byte) []byte {
	var b bytes.Buffer
	_ = binary.Write(&b, binary.BigEndian, uint32(len(data)))
	b.WriteString(typ)
	b.Write(data)
	b.Write([]byte{0, 0, 0, 0}) // CRC (a detecção não confere)
	return b.Bytes()
}

func webp(flags byte, withVP8X bool) []byte {
	var body bytes.Buffer
	body.WriteString("WEBP")
	if withVP8X {
		body.WriteString("VP8X")
		_ = binary.Write(&body, binary.LittleEndian, uint32(10))
		body.Write([]byte{flags, 0, 0, 0, 1, 0, 0, 1, 0, 0})
	} else {
		body.WriteString("VP8 ")
		_ = binary.Write(&body, binary.LittleEndian, uint32(4))
		body.Write([]byte{1, 2, 3, 4})
	}
	var out bytes.Buffer
	out.WriteString("RIFF")
	_ = binary.Write(&out, binary.LittleEndian, uint32(body.Len()))
	out.Write(body.Bytes())
	return out.Bytes()
}

func TestIsAnimatedImage(t *testing.T) {
	var staticPNG bytes.Buffer
	if err := png.Encode(&staticPNG, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	sig := []byte("\x89PNG\r\n\x1a\n")
	apng := append(append(append(append([]byte{}, sig...), pngChunk("IHDR", make([]byte, 13))...), pngChunk("acTL", make([]byte, 8))...), pngChunk("IDAT", []byte{1})...)
	acTLAfterIDAT := append(append(append(append([]byte{}, sig...), pngChunk("IHDR", make([]byte, 13))...), pngChunk("IDAT", []byte{1})...), pngChunk("acTL", make([]byte, 8))...)

	cases := []struct {
		name string
		data []byte
		want bool
	}{
		{"gif animado", gifBytes(t, 3), true},
		{"gif de um quadro (bloqueio por tipo)", gifBytes(t, 1), true},
		{"png estático", staticPNG.Bytes(), false},
		{"apng", apng, true},
		{"acTL depois do IDAT não conta", acTLAfterIDAT, false},
		{"webp animado", webp(0x02|0x10, true), true},
		{"webp estático com VP8X", webp(0x10, true), false},
		{"webp estático simples", webp(0, false), false},
		{"jpeg", []byte("\xff\xd8\xff\xe0 resto"), false},
		{"vazio", nil, false},
		{"truncado", []byte("RIFF"), false},
		{"png truncado", sig, false},
	}
	for _, c := range cases {
		if got := isAnimatedImage(c.data); got != c.want {
			t.Errorf("%s: isAnimatedImage = %v, esperado %v", c.name, got, c.want)
		}
	}
}
