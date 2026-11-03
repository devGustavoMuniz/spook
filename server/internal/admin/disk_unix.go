//go:build !windows

package admin

import "syscall"

// statDisk devolve o total e o espaço livre (para não-root) do volume que contém path.
func statDisk(path string) (total, free uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Bsize)
	return st.Blocks * bs, st.Bavail * bs, nil
}
