package httpapi

import (
	"context"
	"net/netip"
	"strings"
	"sync"
	"testing"

	"github.com/psviderski/uncloud/api/pb"
	"github.com/psviderski/uncloud/pkg/api"
	"github.com/psviderski/uncloud/pkg/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/status"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/types/known/emptypb"
)

// fakeMembership serves the cluster's machines and domain, and records removals and new domain records.
type fakeMembership struct {
	pb.UnimplementedClusterServer
	members []*pb.MachineMember
	removed []string
	domain  *pb.Domain
	records []*pb.DNSRecord
}

func (f *fakeMembership) GetDomain(context.Context, *emptypb.Empty) (*pb.Domain, error) {
	if f.domain == nil {
		return nil, status.Error(codes.NotFound, "no cluster domain")
	}
	return f.domain, nil
}

func (f *fakeMembership) CreateDomainRecords(
	_ context.Context, req *pb.CreateDomainRecordsRequest,
) (*pb.CreateDomainRecordsResponse, error) {
	f.records = req.Records
	return &pb.CreateDomainRecordsResponse{Records: req.Records}, nil
}

func (f *fakeMembership) ListMachines(context.Context, *emptypb.Empty) (*pb.ListMachinesResponse, error) {
	return &pb.ListMachinesResponse{Machines: f.members}, nil
}

func (f *fakeMembership) RemoveMachine(_ context.Context, req *pb.RemoveMachineRequest) (*emptypb.Empty, error) {
	f.removed = append(f.removed, req.Id)
	return &emptypb.Empty{}, nil
}

// fakeMachineAPI answers as the connected machine and records which machine each reset targeted.
type fakeMachineAPI struct {
	pb.UnimplementedMachineServer
	connected string
	resets    []string
}

func (f *fakeMachineAPI) Inspect(context.Context, *emptypb.Empty) (*pb.MachineInfo, error) {
	return &pb.MachineInfo{Id: f.connected}, nil
}

func (f *fakeMachineAPI) InspectMachine(context.Context, *emptypb.Empty) (*pb.InspectMachineResponse, error) {
	return &pb.InspectMachineResponse{}, nil
}

func (f *fakeMachineAPI) Reset(ctx context.Context, _ *pb.ResetRequest) (*emptypb.Empty, error) {
	f.resets = append(f.resets, targetMachine(ctx))
	return &emptypb.Empty{}, nil
}

// fakeDocker lists a machine's containers and records what happened to each, on which machine.
type fakeDocker struct {
	pb.UnimplementedDockerServer
	containers []string
	listErr    error
	stopErrs   map[string]error

	mu    sync.Mutex
	calls []string
}

func (f *fakeDocker) ListServiceContainers(
	context.Context, *pb.ListServiceContainersRequest,
) (*pb.ListServiceContainersResponse, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	machine := &pb.MachineServiceContainers{}
	for _, id := range f.containers {
		machine.Containers = append(machine.Containers, &pb.ServiceContainer{
			Container:   []byte(`{"Id":"` + id + `","Name":"/` + id + `"}`),
			ServiceSpec: []byte(`{}`),
		})
	}
	return &pb.ListServiceContainersResponse{Messages: []*pb.MachineServiceContainers{machine}}, nil
}

func (f *fakeDocker) StopContainer(ctx context.Context, req *pb.StopContainerRequest) (*emptypb.Empty, error) {
	f.record("stop " + req.Id + " on " + targetMachine(ctx))
	return &emptypb.Empty{}, f.stopErrs[req.Id]
}

func (f *fakeDocker) RemoveServiceContainer(ctx context.Context, req *pb.RemoveContainerRequest) (*emptypb.Empty, error) {
	f.record("remove " + req.Id + " on " + targetMachine(ctx))
	return &emptypb.Empty{}, nil
}

func (f *fakeDocker) record(call string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, call)
}

// targetMachine is the machine a request was proxied to, or empty for the connected machine.
func targetMachine(ctx context.Context) string {
	md, _ := metadata.FromIncomingContext(ctx)
	return strings.Join(md.Get("machine"), ",")
}

func newRemovalBackend(
	t *testing.T, cluster *fakeMembership, machine *fakeMachineAPI, docker *fakeDocker,
) *clientBackend {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterClusterServer(server, cluster)
	pb.RegisterMachineServer(server, machine)
	pb.RegisterDockerServer(server, docker)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	cli, err := client.New(t.Context(), bufconnConnector{listener: listener})
	require.NoError(t, err)
	t.Cleanup(func() { _ = cli.Close() })
	return &clientBackend{Client: cli}
}

// member resolves a machine like the remove handler does before removing it.
func member(t *testing.T, backend *clientBackend, nameOrID string) api.MachineMember {
	t.Helper()
	machine, err := backend.InspectMachine(t.Context(), nameOrID)
	require.NoError(t, err)
	return machine
}

// twoMachines is a cluster reached through "main", with "worker" in the given state.
func twoMachines(worker pb.MachineMember_MembershipState) *fakeMembership {
	return &fakeMembership{members: []*pb.MachineMember{
		{Machine: &pb.MachineInfo{Id: "main-id", Name: "main"}, State: pb.MachineMember_UP},
		{Machine: &pb.MachineInfo{Id: "worker-id", Name: "worker"}, State: worker},
	}}
}

func TestRemoveMachineClearsAndResetsAMachineThatAnswers(t *testing.T) {
	cluster := twoMachines(pb.MachineMember_UP)
	machine := &fakeMachineAPI{connected: "main-id"}
	docker := &fakeDocker{containers: []string{"web-1", "caddy-1"}}
	backend := newRemovalBackend(t, cluster, machine, docker)

	removed, err := backend.RemoveMachine(t.Context(), member(t, backend, "worker"))
	require.NoError(t, err)

	assert.Equal(t, RemoveMachineResponse{ID: "worker-id", Name: "worker", Containers: 2, Reset: true}, removed)
	assert.ElementsMatch(t, []string{
		"stop web-1 on worker-id", "remove web-1 on worker-id",
		"stop caddy-1 on worker-id", "remove caddy-1 on worker-id",
	}, docker.calls)
	assert.Equal(t, []string{"worker-id"}, machine.resets)
	assert.Equal(t, []string{"worker-id"}, cluster.removed)
}

func TestRemoveMachineOnlyRemovesAMachineThatDoesNotAnswer(t *testing.T) {
	for name, setup := range map[string]func() (*fakeMembership, *fakeDocker){
		"down": func() (*fakeMembership, *fakeDocker) {
			return twoMachines(pb.MachineMember_DOWN), &fakeDocker{containers: []string{"web-1"}}
		},
		"unreachable": func() (*fakeMembership, *fakeDocker) {
			return twoMachines(pb.MachineMember_SUSPECT), &fakeDocker{listErr: status.Error(codes.Unavailable, "no route")}
		},
	} {
		t.Run(name, func(t *testing.T) {
			cluster, docker := setup()
			machine := &fakeMachineAPI{connected: "main-id"}
			backend := newRemovalBackend(t, cluster, machine, docker)

			removed, err := backend.RemoveMachine(t.Context(), member(t, backend, "worker-id"))
			require.NoError(t, err)

			assert.Equal(t, RemoveMachineResponse{ID: "worker-id", Name: "worker"}, removed)
			assert.Empty(t, docker.calls)
			assert.Empty(t, machine.resets)
			assert.Equal(t, []string{"worker-id"}, cluster.removed)
		})
	}
}

func TestRemoveMachineRefusesTheConnectedMachine(t *testing.T) {
	cluster := twoMachines(pb.MachineMember_UP)
	docker := &fakeDocker{containers: []string{"web-1"}}
	backend := newRemovalBackend(t, cluster, &fakeMachineAPI{connected: "main-id"}, docker)

	_, err := backend.RemoveMachine(t.Context(), member(t, backend, "main"))
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
	assert.Empty(t, docker.calls)
	assert.Empty(t, cluster.removed)
}

func TestRemoveMachineKeepsTheMachineWhenAContainerCannotBeRemoved(t *testing.T) {
	cluster := twoMachines(pb.MachineMember_UP)
	machine := &fakeMachineAPI{connected: "main-id"}
	docker := &fakeDocker{
		containers: []string{"gone-1", "stuck-1"},
		stopErrs: map[string]error{
			"gone-1":  status.Error(codes.NotFound, "no such container"),
			"stuck-1": status.Error(codes.Internal, "timed out"),
		},
	}
	backend := newRemovalBackend(t, cluster, machine, docker)

	_, err := backend.RemoveMachine(t.Context(), member(t, backend, "worker"))
	require.ErrorContains(t, err, "container stuck-1")
	assert.NotContains(t, err.Error(), "gone-1")
	assert.Contains(t, docker.calls, "remove gone-1 on worker-id")
	assert.NotContains(t, docker.calls, "remove stuck-1 on worker-id")
	assert.Empty(t, machine.resets)
	assert.Empty(t, cluster.removed)
}

func TestRemoveMachineKeepsTheRecordsWhenNoIngressAnswers(t *testing.T) {
	cluster := twoMachines(pb.MachineMember_UP)
	cluster.members[1].Machine.PublicIp = pb.NewIP(netip.MustParseAddr("203.0.113.11"))
	reserved := true
	cluster.domain = &pb.Domain{Name: "abc123.uncld.dev", Reserved: &reserved}
	backend := newRemovalBackend(t, cluster, &fakeMachineAPI{connected: "main-id"}, &fakeDocker{})

	removed, err := backend.RemoveMachine(t.Context(), member(t, backend, "worker"))
	require.NoError(t, err)
	assert.Equal(t, "worker-id", removed.ID)
	assert.Equal(t, []string{"worker-id"}, cluster.removed)
	assert.Empty(t, cluster.records)
}

func TestUpdateIngressRecordsNeedsADomainReservedInUncloudDNS(t *testing.T) {
	cluster := twoMachines(pb.MachineMember_UP)
	backend := newRemovalBackend(t, cluster, &fakeMachineAPI{connected: "main-id"}, &fakeDocker{})

	_, err := backend.UpdateIngressRecords(t.Context())
	assert.ErrorIs(t, err, api.ErrNotFound)

	external := false
	cluster.domain = &pb.Domain{Name: "apps.example.com", Reserved: &external}
	_, err = backend.UpdateIngressRecords(t.Context())
	assert.Equal(t, codes.FailedPrecondition, status.Code(err))
	assert.Empty(t, cluster.records)
}

func TestClusterDiagnosticsMarksTheConnectedMachine(t *testing.T) {
	backend := newRemovalBackend(t, twoMachines(pb.MachineMember_UP), &fakeMachineAPI{connected: "main-id"}, &fakeDocker{})

	diagnostics, err := backend.ClusterDiagnostics(t.Context())
	require.NoError(t, err)

	connected := map[string]bool{}
	for _, machine := range diagnostics.Machines {
		connected[machine.Name] = machine.Connected
	}
	assert.Equal(t, map[string]bool{"main": true, "worker": false}, connected)
}
