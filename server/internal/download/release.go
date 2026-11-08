package download

import (
	"encoding/json"
	"regexp"
	"strings"
)

// Installer é um instalador do app desktop (um asset do release do GitHub).
type Installer struct {
	Name        string  `json:"name" doc:"Nome do arquivo: Spook-<versão>-<so>-<arquitetura>.<extensão>"`
	OS          string  `json:"os" enum:"windows,macos,linux"`
	Arch        string  `json:"arch" enum:"x64,arm64"`
	Kind        string  `json:"kind" enum:"exe,dmg,deb,AppImage"`
	URL         string  `json:"url" doc:"Link de download"`
	Size        int64   `json:"size" doc:"Tamanho em bytes (0 se desconhecido)"`
	SHA256      *string `json:"sha256" doc:"SHA-256 em hexadecimal (minúsculas), quando o GitHub informa"`
	ChecksumURL *string `json:"checksum_url" doc:"Link do arquivo .sha256 do release, quando existe"`
}

// Release é o último release do app desktop, já normalizado.
type Release struct {
	Version     string      `json:"version" doc:"Versão do app, sem o prefixo desktop-v"`
	PublishedAt *string     `json:"published_at" doc:"Data de publicação (RFC 3339)"`
	PageURL     string      `json:"page_url" doc:"Página do release no GitHub"`
	Installers  []Installer `json:"installers"`
}

var (
	installerName = regexp.MustCompile(`^Spook-.+-(windows|macos|linux)-(x64|arm64)\.(exe|dmg|deb|AppImage)$`)
	digestRe      = regexp.MustCompile(`(?i)^sha256:([0-9a-f]{64})$`)
)

type rawAsset struct {
	Name               string `json:"name"`
	Size               int64  `json:"size"`
	BrowserDownloadURL string `json:"browser_download_url"`
	Digest             string `json:"digest"`
}

type rawRelease struct {
	TagName     string     `json:"tag_name"`
	PublishedAt string     `json:"published_at"`
	HTMLURL     string     `json:"html_url"`
	Assets      []rawAsset `json:"assets"`
}

// parseRelease converte a resposta crua do GitHub em Release. Devolve (nil, nil) quando não há nenhum
// instalador reconhecível (.sig, .sha256, latest.json e bundles do updater são ignorados) e erro quando o JSON
// é inválido. fallbackPage é usado se o release não trouxer html_url.
func parseRelease(body []byte, fallbackPage string) (*Release, error) {
	var raw rawRelease
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	urls := make(map[string]string, len(raw.Assets))
	for _, a := range raw.Assets {
		if a.Name != "" && a.BrowserDownloadURL != "" {
			urls[a.Name] = a.BrowserDownloadURL
		}
	}
	var installers []Installer
	for _, a := range raw.Assets {
		if a.Name == "" || a.BrowserDownloadURL == "" {
			continue
		}
		m := installerName.FindStringSubmatch(a.Name)
		if m == nil {
			continue
		}
		in := Installer{Name: a.Name, OS: m[1], Arch: m[2], Kind: m[3], URL: a.BrowserDownloadURL, Size: max(a.Size, 0)}
		if d := digestRe.FindStringSubmatch(a.Digest); d != nil {
			h := strings.ToLower(d[1])
			in.SHA256 = &h
		}
		if u, ok := urls[a.Name+".sha256"]; ok {
			in.ChecksumURL = &u
		}
		installers = append(installers, in)
	}
	if len(installers) == 0 {
		return nil, nil
	}
	version := strings.TrimPrefix(strings.TrimPrefix(raw.TagName, "desktop-v"), "v")
	if version == "" {
		version = "?"
	}
	rel := &Release{Version: version, PageURL: raw.HTMLURL, Installers: installers}
	if rel.PageURL == "" {
		rel.PageURL = fallbackPage
	}
	if raw.PublishedAt != "" {
		rel.PublishedAt = &raw.PublishedAt
	}
	return rel, nil
}
