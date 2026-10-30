// Package migrations embute as migrations SQL (goose) no binário.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
