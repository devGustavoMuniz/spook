//go:build integration

package app

import (
	"bytes"
	"image/gif"
	"net/http"
	"testing"
)

// Recorte de GIF no servidor (avatar e banner): o original sobe por URL pré-assinada, o servidor recorta quadro
// a quadro e devolve a chave nova; o original é apagado. Só o próprio usuário, só .gif dele.
func TestCropAnimatedGIFProfileImage(t *testing.T) {
	e := accountEnv(t)
	a := e.newActor(t, "recorte")
	other := e.newActor(t, "recorte2")
	src := animatedGIF() // 16x16, 3 quadros

	for _, kind := range []string{"avatar", "banner"} {
		up := obj(t, a.call(t, "POST", "/api/users/me/"+kind, J{"content_type": "image/gif", "size": len(src)}, 200))
		req, _ := http.NewRequest(http.MethodPut, str(up, "upload_url"), bytes.NewReader(src))
		req.Header.Set("Content-Type", "image/gif")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = resp.Body.Close()
		if resp.StatusCode/100 != 2 {
			t.Skipf("PUT direto ao storage recusado (%d): CORS/rede do ambiente; o CI cobre", resp.StatusCode)
		}
		key := str(up, "key")

		// Outro usuário não recorta o arquivo alheio; retângulo fora da imagem e corpo inválido são 422.
		other.call(t, "POST", "/api/users/me/crop-image", J{"key": key, "x": 0, "y": 0, "width": 8, "height": 8}, 422)
		a.call(t, "POST", "/api/users/me/crop-image", J{"key": key, "x": 100, "y": 100, "width": 8, "height": 8}, 422)
		a.call(t, "POST", "/api/users/me/crop-image", J{"key": key, "x": 0, "y": 0, "width": 0, "height": 8}, 422)
		a.call(t, "POST", "/api/users/me/crop-image", J{"key": "avatars/1/x.png", "x": 0, "y": 0, "width": 8, "height": 8}, 422)

		out := obj(t, a.call(t, "POST", "/api/users/me/crop-image", J{"key": key, "x": 4, "y": 0, "width": 8, "height": 16}, 200))
		newKey := str(out, "key")
		if newKey == "" || newKey == key {
			t.Fatalf("deveria devolver uma chave nova: %v", out)
		}
		me := obj(t, a.call(t, "PATCH", "/api/users/me", J{kind + "_key": newKey}, 200))
		got, ct := download(t, str(me, kind+"_url"))
		g, err := gif.DecodeAll(bytes.NewReader(got))
		if err != nil || ct != "image/gif" {
			t.Fatalf("%s: GIF inválido (%s): %v", kind, ct, err)
		}
		if len(g.Image) != 3 || g.Config.Width != 8 || g.Config.Height != 16 {
			t.Fatalf("%s: quadros=%d tamanho=%dx%d", kind, len(g.Image), g.Config.Width, g.Config.Height)
		}
		// O original foi apagado: recortar de novo a mesma chave falha.
		a.call(t, "POST", "/api/users/me/crop-image", J{"key": key, "x": 0, "y": 0, "width": 8, "height": 8}, 422)
	}
	a.do(t, "POST", "/api/users/me/crop-image", nil) // corpo vazio não derruba o servidor
}
