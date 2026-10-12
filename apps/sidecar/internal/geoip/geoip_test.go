package geoip

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInstallCopiesOnlyChangedDatabases(t *testing.T) {
	source := filepath.Join(t.TempDir(), FileName)
	dir := filepath.Join(t.TempDir(), "var", "lib", "stoat", "geoip")
	require.NoError(t, os.WriteFile(source, append([]byte("tree"), metadataMarker...), 0o600))

	changed, err := Install(source, dir)
	require.NoError(t, err)
	assert.True(t, changed)

	installed, err := os.ReadFile(filepath.Join(dir, FileName))
	require.NoError(t, err)
	assert.Equal(t, append([]byte("tree"), metadataMarker...), installed)

	info, err := os.Stat(filepath.Join(dir, FileName))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0o644), info.Mode().Perm())

	changed, err = Install(source, dir)
	require.NoError(t, err)
	assert.False(t, changed)

	require.NoError(t, os.WriteFile(source, append([]byte("newer tree"), metadataMarker...), 0o600))
	changed, err = Install(source, dir)
	require.NoError(t, err)
	assert.True(t, changed)

	entries, err := os.ReadDir(dir)
	require.NoError(t, err)
	assert.Len(t, entries, 1, "temporary files must not be left behind")
}

func TestInstallRejectsFilesThatAreNotMaxMindDatabases(t *testing.T) {
	source := filepath.Join(t.TempDir(), FileName)
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(source, []byte("<html>rate limited</html>"), 0o600))

	_, err := Install(source, dir)
	require.Error(t, err)
	assert.NoFileExists(t, filepath.Join(dir, FileName))
}
