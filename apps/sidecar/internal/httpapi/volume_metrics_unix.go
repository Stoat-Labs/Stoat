package httpapi

import (
	"io/fs"
	"syscall"
)

// allocatedBytes is the disk space a file takes (512-byte blocks), so sparse files
// count as du does; it falls back to the apparent size where blocks are unknown.
func allocatedBytes(info fs.FileInfo) int64 {
	if stat, ok := info.Sys().(*syscall.Stat_t); ok {
		return stat.Blocks * 512
	}
	return info.Size()
}
