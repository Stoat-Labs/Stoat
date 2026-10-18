package httpapi

import (
	"context"
	"fmt"
	"io/fs"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/psviderski/uncloud/pkg/api"
)

const (
	// defaultHostRoot is where docker-compose.yml mounts the host's root filesystem.
	defaultHostRoot = "/host"
	// volumeSizeTTL spaces out directory walks: Alloy scrapes every 15 seconds, but a
	// volume's size moves slowly and walking a large one is expensive.
	volumeSizeTTL = 5 * time.Minute
	// volumeSizeTimeout bounds one pass over every volume on the machine.
	volumeSizeTimeout = 10 * time.Minute
)

// volumeSizes measures this machine's Docker volumes in the background, so a scrape
// returns the last measurement instead of waiting on the walk.
type volumeSizes struct {
	hostRoot string

	mu         sync.Mutex
	sizes      map[string]int64
	measuredAt time.Time
	running    bool
}

// exposition renders the last measurement as Prometheus text and starts a new one
// when it is stale.
func (v *volumeSizes) exposition(list func(context.Context) ([]api.MachineVolume, error)) []byte {
	v.mu.Lock()
	defer v.mu.Unlock()

	if !v.running && time.Since(v.measuredAt) > volumeSizeTTL {
		v.running = true
		go v.measure(list)
	}
	if len(v.sizes) == 0 {
		return nil
	}

	names := make([]string, 0, len(v.sizes))
	for name := range v.sizes {
		names = append(names, name)
	}
	sort.Strings(names)

	var out strings.Builder
	out.WriteString("# HELP stoat_volume_size_bytes Disk space used by a Docker volume's files.\n")
	out.WriteString("# TYPE stoat_volume_size_bytes gauge\n")
	for _, name := range names {
		fmt.Fprintf(&out, "stoat_volume_size_bytes{volume=%q} %d\n", name, v.sizes[name])
	}
	return []byte(out.String())
}

func (v *volumeSizes) measure(list func(context.Context) ([]api.MachineVolume, error)) {
	ctx, cancel := context.WithTimeout(context.Background(), volumeSizeTimeout)
	defer cancel()

	sizes := map[string]int64{}
	if volumes, err := list(ctx); err == nil {
		for _, machineVolume := range volumes {
			volume := machineVolume.Volume
			if volume.Driver != "local" || volume.Mountpoint == "" {
				continue
			}
			size, ok := directorySize(ctx, filepath.Join(v.hostRoot, volume.Mountpoint))
			if ok {
				sizes[volume.Name] = size
			}
		}
	}

	v.mu.Lock()
	defer v.mu.Unlock()
	v.running = false
	v.measuredAt = time.Now()
	// A failed pass keeps the last good sizes rather than blanking the chart.
	if len(sizes) > 0 {
		v.sizes = sizes
	}
}

// directorySize adds up the allocated size of every file, like du, without following links.
func directorySize(ctx context.Context, root string) (int64, bool) {
	var total int64
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if err != nil {
			// Files deleted mid-walk are expected on a live volume.
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return nil
		}
		total += allocatedBytes(info)
		return nil
	})
	return total, err == nil
}
