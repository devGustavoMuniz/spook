//go:build windows

package admin

import "errors"

func statDisk(string) (total, free uint64, err error) {
	return 0, 0, errors.New("medição de disco não suportada no Windows")
}
