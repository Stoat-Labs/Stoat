package httpapi

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"testing"
	"time"

	"github.com/psviderski/uncloud/api/pb"
	"github.com/psviderski/uncloud/pkg/client"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"golang.org/x/net/proxy"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/emptypb"
)

// fakeCluster records which domain RPCs the backend chose to call.
type fakeCluster struct {
	pb.UnimplementedClusterServer
	domain   *pb.Domain
	calls    []string
	setNames []string
}

func (f *fakeCluster) GetDomain(context.Context, *emptypb.Empty) (*pb.Domain, error) {
	return f.domain, nil
}

func (f *fakeCluster) SetDomain(_ context.Context, req *pb.SetDomainRequest) (*emptypb.Empty, error) {
	f.calls = append(f.calls, "SetDomain")
	f.setNames = append(f.setNames, req.Name)
	return &emptypb.Empty{}, nil
}

func (f *fakeCluster) ReleaseDomain(context.Context, *emptypb.Empty) (*pb.Domain, error) {
	f.calls = append(f.calls, "ReleaseDomain")
	return f.domain, nil
}

type fakeCaddyStorage struct {
	pb.UnimplementedCaddyStorageServer
	certificates []*pb.IssuedCertificate
	machine      []string
}

func (f *fakeCaddyStorage) ListCertificates(ctx context.Context, _ *emptypb.Empty) (*pb.ListCertificatesResponse, error) {
	md, _ := metadata.FromIncomingContext(ctx)
	f.machine = md.Get("machine")
	return &pb.ListCertificatesResponse{Certificates: f.certificates}, nil
}

// bufconnConnector serves the uncloud client from an in-memory gRPC server.
type bufconnConnector struct {
	listener *bufconn.Listener
}

func (c bufconnConnector) Connect(context.Context) (*grpc.ClientConn, error) {
	return grpc.NewClient("passthrough:///bufnet",
		grpc.WithContextDialer(func(ctx context.Context, _ string) (net.Conn, error) {
			return c.listener.DialContext(ctx)
		}),
		grpc.WithTransportCredentials(insecure.NewCredentials()),
	)
}

func (bufconnConnector) Dialer() (proxy.ContextDialer, error) {
	return nil, errors.New("not supported")
}

func (bufconnConnector) Close() error { return nil }

func newGRPCBackend(t *testing.T, cluster *fakeCluster, storage *fakeCaddyStorage) *clientBackend {
	t.Helper()
	listener := bufconn.Listen(1 << 20)
	server := grpc.NewServer()
	pb.RegisterClusterServer(server, cluster)
	pb.RegisterCaddyStorageServer(server, storage)
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(server.Stop)

	cli, err := client.New(t.Context(), bufconnConnector{listener: listener})
	require.NoError(t, err)
	t.Cleanup(func() { _ = cli.Close() })
	return &clientBackend{Client: cli}
}

func TestClearClusterDomainReleasesReservedDomain(t *testing.T) {
	cluster := &fakeCluster{domain: &pb.Domain{Name: "abc.uncld.dev", Reserved: proto.Bool(true)}}
	backend := newGRPCBackend(t, cluster, &fakeCaddyStorage{})

	require.NoError(t, backend.ClearClusterDomain(t.Context()))
	assert.Equal(t, []string{"ReleaseDomain"}, cluster.calls)
}

func TestClearClusterDomainUnsetsExternalDomain(t *testing.T) {
	cluster := &fakeCluster{domain: &pb.Domain{Name: "apps.example.com", Reserved: proto.Bool(false)}}
	backend := newGRPCBackend(t, cluster, &fakeCaddyStorage{})

	require.NoError(t, backend.ClearClusterDomain(t.Context()))
	assert.Equal(t, []string{"SetDomain"}, cluster.calls)
	assert.Equal(t, []string{""}, cluster.setNames)
}

func TestListCaddyCertificates(t *testing.T) {
	notAfter := time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)
	storage := &fakeCaddyStorage{certificates: []*pb.IssuedCertificate{
		{San: "z.example.com", Chain: testCertificatePEM(t, "z.example.com", notAfter)},
		{
			San:        "a.example.com",
			Chain:      testCertificatePEM(t, "a.example.com", notAfter),
			IssuerData: []byte(`{"url":"https://ca.example/cert/1","ca":"https://ca.example/directory","renewal_info":{"suggestedWindow":{"start":"2026-11-01T00:00:00Z","end":"2026-11-02T00:00:00Z"}}}`),
		},
		{San: "broken.example.com", Chain: []byte("not a certificate")},
	}}
	backend := newGRPCBackend(t, &fakeCluster{}, storage)

	response, err := backend.ListCaddyCertificates(t.Context(), "node-2")
	require.NoError(t, err)
	assert.Equal(t, []string{"node-2"}, storage.machine)

	require.Len(t, response.Items, 2)
	first := response.Items[0]
	assert.Equal(t, "a.example.com", first.SAN)
	assert.Equal(t, []string{"a.example.com"}, first.DNSNames)
	assert.Equal(t, "Test CA", first.Issuer)
	assert.Equal(t, "Stoat", first.IssuerOrganization)
	assert.Equal(t, notAfter, first.NotAfter)
	assert.Len(t, first.SHA256, 64)
	require.NotNil(t, first.ACME)
	assert.Equal(t, "https://ca.example/directory", first.ACME.CA)
	assert.Equal(t, time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC), first.ACME.RenewalWindowStart)
	assert.Equal(t, "z.example.com", response.Items[1].SAN)
	assert.Nil(t, response.Items[1].ACME)

	require.Len(t, response.Errors, 1)
	assert.Contains(t, response.Errors[0], "broken.example.com")
}

func testCertificatePEM(t *testing.T, san string, notAfter time.Time) []byte {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	require.NoError(t, err)
	template := &x509.Certificate{
		SerialNumber: big.NewInt(42),
		Subject:      pkix.Name{CommonName: san},
		Issuer:       pkix.Name{CommonName: "Test CA", Organization: []string{"Stoat"}},
		DNSNames:     []string{san},
		NotBefore:    notAfter.Add(-90 * 24 * time.Hour),
		NotAfter:     notAfter,
	}
	// A self-signed certificate takes its issuer from the parent, so the
	// template doubles as the parent to get a recognizable issuer name.
	parent := *template
	parent.Subject = template.Issuer
	der, err := x509.CreateCertificate(rand.Reader, template, &parent, &key.PublicKey, key)
	require.NoError(t, err)
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}
