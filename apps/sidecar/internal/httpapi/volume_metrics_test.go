package httpapi

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/docker/docker/api/types/volume"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestVolumeSizesExposition(t *testing.T) {
	root := t.TempDir()
	data := filepath.Join(root, "var/lib/docker/volumes/app-data/_data")
	require.NoError(t, os.MkdirAll(data, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(data, "file"), make([]byte, 8192), 0o644))

	sizes := &volumeSizes{hostRoot: root}
	list := func(context.Context) ([]api.MachineVolume, error) {
		return []api.MachineVolume{{Volume: volume.Volume{
			Name: "app-data", Driver: "local", Mountpoint: "/var/lib/docker/volumes/app-data/_data",
		}}}, nil
	}

	// The first scrape starts the measurement and has nothing to report yet.
	assert.Empty(t, sizes.exposition(list))

	require.Eventually(t, func() bool {
		return len(sizes.exposition(list)) > 0
	}, 5*time.Second, 10*time.Millisecond)
	assert.Contains(t, string(sizes.exposition(list)), `stoat_volume_size_bytes{volume="app-data"} `)
}
