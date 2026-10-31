package attachment

import (
	"encoding/binary"
	"image"
)

// jpegOrientation lê a orientação EXIF (tag 0x0112, valores 1 a 8) de um JPEG. Qualquer coisa fora do
// esperado (não é JPEG, sem EXIF, EXIF truncado ou inválido) devolve 1 (sem transformação).
func jpegOrientation(data []byte) int {
	if len(data) < 4 || data[0] != 0xFF || data[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(data) {
		if data[i] != 0xFF {
			return 1
		}
		marker := data[i+1]
		if marker == 0xFF { // preenchimento
			i++
			continue
		}
		if marker == 0xDA || marker == 0xD9 { // início dos dados da imagem / fim
			return 1
		}
		if marker == 0x01 || (marker >= 0xD0 && marker <= 0xD7) { // marcadores sem tamanho
			i += 2
			continue
		}
		size := int(binary.BigEndian.Uint16(data[i+2 : i+4]))
		if size < 2 || i+2+size > len(data) {
			return 1
		}
		if marker == 0xE1 { // APP1
			seg := data[i+4 : i+2+size]
			if o := tiffOrientation(seg); o != 0 {
				return o
			}
		}
		i += 2 + size
	}
	return 1
}

// tiffOrientation procura a orientação dentro de um segmento APP1 "Exif\0\0" + cabeçalho TIFF; 0 = não achou.
func tiffOrientation(seg []byte) int {
	if len(seg) < 14 || string(seg[:6]) != "Exif\x00\x00" {
		return 0
	}
	t := seg[6:]
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 0
	}
	if bo.Uint16(t[2:4]) != 42 {
		return 0
	}
	ifd := int(bo.Uint32(t[4:8]))
	if ifd < 8 || ifd+2 > len(t) {
		return 0
	}
	n := int(bo.Uint16(t[ifd : ifd+2]))
	for k := 0; k < n; k++ {
		e := ifd + 2 + k*12
		if e+12 > len(t) {
			return 0
		}
		if bo.Uint16(t[e:e+2]) != 0x0112 { // Orientation
			continue
		}
		if bo.Uint16(t[e+2:e+4]) != 3 || bo.Uint32(t[e+4:e+8]) != 1 { // SHORT, 1 valor
			return 0
		}
		if v := int(bo.Uint16(t[e+8 : e+10])); v >= 1 && v <= 8 {
			return v
		}
		return 0
	}
	return 0
}

// orient aplica a orientação EXIF (1 a 8) a src. Para 5 a 8 a largura e a altura se trocam.
func orient(src *image.RGBA, o int) *image.RGBA {
	if o < 2 || o > 8 {
		return src
	}
	w, h := src.Bounds().Dx(), src.Bounds().Dy()
	dw, dh := w, h
	if o >= 5 {
		dw, dh = h, w
	}
	dst := image.NewRGBA(image.Rect(0, 0, dw, dh))
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			var sx, sy int
			switch o {
			case 2: // espelho horizontal
				sx, sy = w-1-x, y
			case 3: // 180°
				sx, sy = w-1-x, h-1-y
			case 4: // espelho vertical
				sx, sy = x, h-1-y
			case 5: // transposta
				sx, sy = y, x
			case 6: // 90° horário
				sx, sy = y, h-1-x
			case 7: // transversa
				sx, sy = w-1-y, h-1-x
			case 8: // 90° anti-horário
				sx, sy = w-1-y, x
			}
			si := src.PixOffset(sx, sy)
			di := dst.PixOffset(x, y)
			copy(dst.Pix[di:di+4], src.Pix[si:si+4])
		}
	}
	return dst
}

// orientedSize devolve as dimensões como o navegador as exibe depois de aplicar a orientação.
func orientedSize(w, h, o int) (int, int) {
	if o >= 5 && o <= 8 {
		return h, w
	}
	return w, h
}
