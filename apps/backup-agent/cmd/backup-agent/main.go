// Command backup-agent is a minimal example of driving Kopia as a Go library:
// create/connect a repository, snapshot a directory, list snapshots, and
// restore the latest one.
//
//	go run ./cmd/backup-agent -repo /tmp/kopia-repo -source ./some-dir -restore /tmp/restored
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"math"
	"os"
	"path/filepath"

	"github.com/kopia/kopia/fs/localfs"
	"github.com/kopia/kopia/repo"
	"github.com/kopia/kopia/repo/blob"
	"github.com/kopia/kopia/repo/blob/filesystem"
	"github.com/kopia/kopia/snapshot"
	"github.com/kopia/kopia/snapshot/policy"
	"github.com/kopia/kopia/snapshot/restore"
	"github.com/kopia/kopia/snapshot/snapshotfs"
	"github.com/kopia/kopia/snapshot/upload"
)

func main() {
	repoPath := flag.String("repo", "/tmp/kopia-repo", "filesystem repository path (swap for s3.New etc. in production)")
	configFile := flag.String("config", "/tmp/kopia-agent/repository.config", "local Kopia connection config")
	source := flag.String("source", ".", "directory to back up")
	restoreTo := flag.String("restore", "", "if set, restore the latest snapshot here")
	flag.Parse()

	password := os.Getenv("KOPIA_PASSWORD")
	if password == "" {
		log.Fatal("KOPIA_PASSWORD is required")
	}

	ctx := context.Background()

	rep, err := openRepository(ctx, *repoPath, *configFile, password)
	if err != nil {
		log.Fatal(err)
	}
	defer rep.Close(ctx)

	absSource, err := filepath.Abs(*source)
	if err != nil {
		log.Fatal(err)
	}

	man, err := backup(ctx, rep, absSource)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("snapshot %s: %d files, %d bytes\n", man.ID, man.Stats.TotalFileCount, man.Stats.TotalFileSize)

	snaps, err := snapshot.ListSnapshots(ctx, rep, man.Source)
	if err != nil {
		log.Fatal(err)
	}
	for _, s := range snaps {
		fmt.Printf("  %s  %s\n", s.ID, s.StartTime.ToTime().Format("2006-01-02 15:04:05"))
	}

	if *restoreTo != "" {
		if err := restoreSnapshot(ctx, rep, man, *restoreTo); err != nil {
			log.Fatal(err)
		}
		fmt.Printf("restored %s to %s\n", man.ID, *restoreTo)
	}
}

// openRepository initializes the repository on first use, writes a local
// connection config, and opens it.
func openRepository(ctx context.Context, repoPath, configFile, password string) (repo.Repository, error) {
	if err := os.MkdirAll(repoPath, 0o700); err != nil {
		return nil, err
	}

	st, err := filesystem.New(ctx, &filesystem.Options{Path: repoPath}, true)
	if err != nil {
		return nil, fmt.Errorf("open storage: %w", err)
	}
	defer st.Close(ctx)

	if err := connect(ctx, st, configFile, password); err != nil {
		return nil, err
	}

	return repo.Open(ctx, configFile, password, &repo.Options{})
}

func connect(ctx context.Context, st blob.Storage, configFile, password string) error {
	if _, err := os.Stat(configFile); err == nil {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(configFile), 0o700); err != nil {
		return err
	}

	opts := &repo.ConnectOptions{
		ClientOptions: repo.ClientOptions{Hostname: "stoat-agent", Username: "stoat"},
	}

	err := repo.Connect(ctx, configFile, st, password, opts)
	if !errors.Is(err, repo.ErrRepositoryNotInitialized) {
		return err
	}

	if err := repo.Initialize(ctx, st, &repo.NewRepositoryOptions{}, password); err != nil {
		return fmt.Errorf("initialize repository: %w", err)
	}
	return repo.Connect(ctx, configFile, st, password, opts)
}

// backup uploads a directory and saves the snapshot manifest in a single write session.
func backup(ctx context.Context, rep repo.Repository, path string) (*snapshot.Manifest, error) {
	dir, err := localfs.Directory(path)
	if err != nil {
		return nil, err
	}

	source := snapshot.SourceInfo{
		Host:     rep.ClientOptions().Hostname,
		UserName: rep.ClientOptions().Username,
		Path:     path,
	}

	var man *snapshot.Manifest
	err = repo.WriteSession(ctx, rep, repo.WriteSessionOptions{Purpose: "backup"}, func(ctx context.Context, w repo.RepositoryWriter) error {
		policyTree, err := policy.TreeForSource(ctx, w, source)
		if err != nil {
			return err
		}

		// Passing previous snapshots lets Kopia skip unchanged files.
		previous, err := snapshot.ListSnapshots(ctx, w, source)
		if err != nil {
			return err
		}

		man, err = upload.NewUploader(w).Upload(ctx, dir, policyTree, source, previous...)
		if err != nil {
			return err
		}

		_, err = snapshot.SaveSnapshot(ctx, w, man)
		return err
	})

	return man, err
}

func restoreSnapshot(ctx context.Context, rep repo.Repository, man *snapshot.Manifest, target string) error {
	root, err := snapshotfs.SnapshotRoot(rep, man)
	if err != nil {
		return err
	}

	out := &restore.FilesystemOutput{
		TargetPath:           target,
		OverwriteDirectories: true,
		OverwriteFiles:       true,
		OverwriteSymlinks:    true,
	}
	if err := out.Init(ctx); err != nil {
		return err
	}

	_, err = restore.Entry(ctx, rep, out, root, restore.Options{
		Parallel: 4,
		// 0 means a shallow restore (placeholder files); MaxInt32 restores the full tree.
		RestoreDirEntryAtDepth: math.MaxInt32,
	})
	return err
}
