// Package webui serve o build do front (SPA) com fallback para index.html.
package webui

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// Handler serve arquivos de dir. Rotas sem arquivo caem em index.html (roteamento no cliente),
// exceto caminhos de API, que continuam 404. Assets com hash no nome (/assets/) são cacheados para
// sempre; todo o resto (index.html, sw.js, manifest, ícones) revalida a cada uso — em especial o
// service worker, que o navegador só atualiza se enxergar o arquivo novo (um sw.js "imutável" prenderia
// os usuários na versão antiga).
func Handler(dir string) http.Handler {
	files := http.FileServer(http.Dir(dir))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			http.NotFound(w, r)
			return
		}
		clean := filepath.Join(dir, filepath.Clean("/"+r.URL.Path))
		info, err := os.Stat(clean)
		if err != nil || info.IsDir() {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(dir, "index.html"))
			return
		}
		if strings.HasPrefix(r.URL.Path, "/assets/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		if strings.HasSuffix(r.URL.Path, ".webmanifest") {
			// O Go não conhece a extensão; sem isso o manifest sairia como text/plain.
			w.Header().Set("Content-Type", "application/manifest+json")
		}
		files.ServeHTTP(w, r)
	})
}
