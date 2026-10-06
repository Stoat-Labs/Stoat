# Stoat backup agent

Minimal example of using Kopia (`github.com/kopia/kopia`, v0.23.1) as a Go library: initialize/connect a repository, snapshot a directory, list snapshots, restore.

```bash
KOPIA_PASSWORD=secret go run ./cmd/backup-agent -repo /tmp/kopia-repo -source ./some-dir -restore /tmp/restored
```

The example uses the filesystem blob backend. For production, swap `filesystem.New` for `s3.New`, `b2.New`, `sftp.New`, etc. from `github.com/kopia/kopia/repo/blob/...`.

Kopia's Go API is not semver-stable; keep it pinned and wrap it behind the agent's own interface.
