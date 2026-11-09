package user

import "bytes"

// isAnimatedImage diz se os bytes são uma imagem que só quem tem Nitro pode usar como avatar ou banner: qualquer
// GIF (animado ou de um quadro só: o bloqueio é por tipo), WebP com a flag de animação ou PNG animado (APNG, com o
// chunk acTL antes dos dados). Lê só os cabeçalhos; não decodifica nada.
func isAnimatedImage(b []byte) bool {
	switch {
	case bytes.HasPrefix(b, []byte("GIF87a")), bytes.HasPrefix(b, []byte("GIF89a")):
		return true
	case len(b) >= 21 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return webpAnimated(b)
	case bytes.HasPrefix(b, []byte("\x89PNG\r\n\x1a\n")):
		return apngAnimated(b)
	}
	return false
}

// webpAnimated procura o chunk VP8X e o bit de animação (0x02) das flags. WebP animado sempre tem VP8X.
func webpAnimated(b []byte) bool {
	i := 12
	for i+8 <= len(b) {
		size := int(b[i+4]) | int(b[i+5])<<8 | int(b[i+6])<<16 | int(b[i+7])<<24
		if string(b[i:i+4]) == "VP8X" {
			return i+8 < len(b) && b[i+8]&0x02 != 0
		}
		i += 8 + size + size&1 // chunks RIFF têm tamanho par (com preenchimento)
		if size < 0 {
			return false
		}
	}
	return false
}

// apngAnimated percorre os chunks do PNG até o primeiro IDAT: o acTL (controle de animação) vem antes dele.
func apngAnimated(b []byte) bool {
	i := 8
	for i+8 <= len(b) {
		size := int(b[i])<<24 | int(b[i+1])<<16 | int(b[i+2])<<8 | int(b[i+3])
		switch string(b[i+4 : i+8]) {
		case "acTL":
			return true
		case "IDAT", "IEND":
			return false
		}
		if size < 0 {
			return false
		}
		i += 12 + size // tamanho + tipo + dados + CRC
	}
	return false
}
