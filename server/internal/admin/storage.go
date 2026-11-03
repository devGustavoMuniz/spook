package admin

import (
	"context"
	"log/slog"
)

// DiskInfo é o uso do volume medido por statfs.
type DiskInfo struct {
	Path       string  `json:"path"`
	TotalBytes uint64  `json:"total_bytes"`
	FreeBytes  uint64  `json:"free_bytes" doc:"Disponível para quem não é root"`
	UsedBytes  uint64  `json:"used_bytes"`
	UsedPct    float64 `json:"used_pct"`
}

// ObjectBytes são os bytes ocupados no S3 por tipo de imagem de perfil. Campo nulo = não medido.
type ObjectBytes struct {
	AvatarsBytes *int64 `json:"avatars_bytes" nullable:"true"`
	IconsBytes   *int64 `json:"icons_bytes" nullable:"true"`
	BannersBytes *int64 `json:"banners_bytes" nullable:"true"`
	Truncated    bool   `json:"truncated" doc:"Algum prefixo passou do teto de objetos lidos: o valor é parcial"`
}

// diskInfo mede o volume de ADMIN_DISK_PATH (padrão "/"); nulo se o sistema não informa.
func (s *Service) diskInfo() *DiskInfo {
	path := s.d.DiskPath
	if path == "" {
		path = "/"
	}
	total, free, err := statDisk(path)
	if err != nil || total == 0 {
		if err != nil {
			slog.Debug("admin: não foi possível medir o disco", "path", path, "err", err)
		}
		return nil
	}
	used := total - min(free, total)
	return &DiskInfo{Path: path, TotalBytes: total, FreeBytes: free, UsedBytes: used, UsedPct: float64(used) / float64(total) * 100}
}

// objectBytes lista o S3 por prefixo (paginado, com teto), com cache de 10 min. Indisponível = nulo, nunca erro.
func (s *Service) objectBytes(ctx context.Context) *ObjectBytes {
	if s.d.Objects == nil {
		return nil
	}
	v, _, err := s.objCell.get(ctx, s.now, func(ctx context.Context) (ObjectBytes, error) {
		var o ObjectBytes
		for _, t := range []struct {
			prefix string
			dst    **int64
		}{{"avatars/", &o.AvatarsBytes}, {"guild-icons/", &o.IconsBytes}, {"banners/", &o.BannersBytes}} {
			b, _, trunc, err := s.d.Objects.PrefixSize(ctx, t.prefix, ObjectScanLimit)
			if err != nil {
				slog.Warn("admin: não foi possível medir o storage", "prefix", t.prefix, "err", err)
				continue // este tipo fica nulo
			}
			n := b
			*t.dst = &n
			o.Truncated = o.Truncated || trunc
		}
		return o, nil
	})
	if err != nil || (v.AvatarsBytes == nil && v.IconsBytes == nil && v.BannersBytes == nil) {
		return nil
	}
	return &v
}
