// Package geoip installs the IP-to-country database that Stoat's Alloy
// collectors read from the host to count visitors by country.
//
// The database is DB-IP's IP to Country Lite, licensed CC BY 4.0
// (https://db-ip.com). It ships inside the sidecar image, so every machine has
// it before monitoring starts, including machines without internet access.
package geoip

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"io"
	"os"
	"path/filepath"
)

// FileName is the database's name in both the image and the host directory.
const FileName = "country.mmdb"

// metadataMarker starts the metadata section of every MaxMind DB file. Alloy
// refuses to start on a file without it, so never install one.
var metadataMarker = []byte("\xab\xcd\xefMaxMind.com")

// Install copies the database at source into dir when its content differs,
// replacing the old file atomically so Alloy never reads a partial one.
// It reports whether the file changed.
func Install(source, dir string) (bool, error) {
	data, err := os.ReadFile(source)
	if err != nil {
		return false, fmt.Errorf("read GeoIP database: %w", err)
	}
	if !bytes.Contains(data[max(0, len(data)-128*1024):], metadataMarker) {
		return false, fmt.Errorf("%s is not a MaxMind DB file", source)
	}

	target := filepath.Join(dir, FileName)
	if current, err := os.ReadFile(target); err == nil && sha256.Sum256(current) == sha256.Sum256(data) {
		return false, nil
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return false, fmt.Errorf("create GeoIP directory: %w", err)
	}
	tmp, err := os.CreateTemp(dir, FileName+".*")
	if err != nil {
		return false, fmt.Errorf("create GeoIP database: %w", err)
	}
	defer func() { _ = os.Remove(tmp.Name()) }()

	if _, err := io.Copy(tmp, bytes.NewReader(data)); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("write GeoIP database: %w", err)
	}
	// Alloy runs as a different user and only needs to read it.
	if err := tmp.Chmod(0o644); err != nil {
		_ = tmp.Close()
		return false, fmt.Errorf("write GeoIP database: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return false, fmt.Errorf("write GeoIP database: %w", err)
	}
	if err := os.Rename(tmp.Name(), target); err != nil {
		return false, fmt.Errorf("install GeoIP database: %w", err)
	}
	return true, nil
}
