package httpapi

import (
	"testing"

	"github.com/docker/docker/api/types/image"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestImageUpdateResponses(t *testing.T) {
	local := []api.MachineImage{{Image: image.InspectResponse{
		ID: "sha256:image", RepoDigests: []string{"registry.example/app@sha256:current"},
	}}}

	current := imageUpdateResponses(local, []RemoteImageResponse{{Digest: "sha256:current"}})
	require.Len(t, current, 1)
	require.NotNil(t, current[0].UpdateAvailable)
	assert.False(t, *current[0].UpdateAvailable)

	outdated := imageUpdateResponses(local, []RemoteImageResponse{{Digest: "sha256:new"}})
	require.Len(t, outdated, 1)
	require.NotNil(t, outdated[0].UpdateAvailable)
	assert.True(t, *outdated[0].UpdateAvailable)

	unknown := imageUpdateResponses(local, nil)
	require.Len(t, unknown, 1)
	assert.Nil(t, unknown[0].UpdateAvailable)
}

func TestIsDockerImageID(t *testing.T) {
	const imageID = "e7adcbed53a49b1f7b616a384fc63da069433c7772f7a05398ee5e9c0b78318e"

	assert.True(t, isDockerImageID("sha256:"+imageID))
	assert.True(t, isDockerImageID(imageID))
	assert.False(t, isDockerImageID("sha256:short"))
	assert.False(t, isDockerImageID("registry.example/app:latest"))
}

func TestImageRemoteReference(t *testing.T) {
	localImages := []api.MachineImage{{Image: image.InspectResponse{
		RepoTags:    []string{"registry.example/app:latest"},
		RepoDigests: []string{"registry.example/app@sha256:current"},
	}}}

	assert.Equal(t, "registry.example/app:latest", mustImageRemoteReference(t, localImages))

	localImages[0].Image.RepoTags = []string{"<none>:<none>"}
	assert.Equal(t, "registry.example/app@sha256:current", mustImageRemoteReference(t, localImages))
}

func TestImageRemoteReferenceRequiresRepositoryReference(t *testing.T) {
	_, err := imageRemoteReference([]api.MachineImage{{Image: image.InspectResponse{}}})
	require.EqualError(t, err, "image has no repository tag or digest")
}

func TestPatchCaddySpecKeepsCustomizations(t *testing.T) {
	deployed := api.ServiceSpec{
		Name: "caddy",
		Mode: api.ServiceModeGlobal,
		Container: api.ContainerSpec{
			Image: "caddy:2.10.0",
			Env:   map[string]string{"CADDY_ADMIN": "unix//run/caddy/admin.sock", "CF_API_TOKEN": "token"},
			VolumeMounts: []api.VolumeMount{
				{VolumeName: "data", ContainerPath: "/data"},
			},
		},
		Placement: api.Placement{Machines: []string{"edge-1"}},
		Caddy:     &api.CaddySpec{Config: "{\n\temail old@example.com\n}"},
	}

	patched := patchCaddySpec(deployed, DeployCaddyRequest{
		Image: "ghcr.io/example/caddy-cloudflare:2.10", Caddyfile: "{\n\temail ops@example.com\n}",
	})
	assert.Equal(t, "ghcr.io/example/caddy-cloudflare:2.10", patched.Container.Image)
	assert.Equal(t, "{\n\temail ops@example.com\n}", patched.CaddyConfig())
	assert.Equal(t, deployed.Container.Env, patched.Container.Env)
	assert.Equal(t, deployed.Container.VolumeMounts, patched.Container.VolumeMounts)
	assert.Equal(t, deployed.Placement, patched.Placement)
	assert.Equal(t, api.ServiceModeGlobal, patched.Mode)
	// The deployed spec is a value, so patching must not touch the caller's copy.
	assert.Equal(t, "caddy:2.10.0", deployed.Container.Image)

	cleared := patchCaddySpec(deployed, DeployCaddyRequest{Image: "caddy:2.10.0"})
	assert.Nil(t, cleared.Caddy)
}

func mustImageRemoteReference(t *testing.T, images []api.MachineImage) string {
	t.Helper()

	ref, err := imageRemoteReference(images)
	require.NoError(t, err)
	return ref
}
