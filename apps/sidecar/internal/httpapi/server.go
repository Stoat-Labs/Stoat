package httpapi

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"reflect"
	"strconv"
	"strings"
	"time"

	scalargo "github.com/bdpiprava/scalar-go"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humafiber"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/volume"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/psviderski/uncloud/pkg/api"
)

const (
	maxExecOutputBytes   = 1024 * 1024
	maxRequestBodyBytes  = 8 * 1024 * 1024
	maxComposeFileBytes  = 4 * 1024 * 1024
	maxMetricsBytes      = 16 * 1024 * 1024
	uncloudMetricsPort   = 51090
	uncloudMetricsPath   = "/metrics"
	metricsClientTimeout = 5 * time.Second

	// DefaultRequestTimeout bounds every request that is neither a command
	// execution nor an event stream. Without it a stuck cluster RPC would pin a
	// connection and a goroutine for the lifetime of the process.
	DefaultRequestTimeout = 60 * time.Second
	// DefaultExecTimeout bounds command execution. Commands are expected to be
	// short-lived operational tasks, not daemons.
	DefaultExecTimeout = 5 * time.Minute

	// readTimeout bounds reading a request head and body from a client.
	readTimeout = 30 * time.Second
	// idleTimeout closes keep-alive connections that never send a request.
	idleTimeout = 2 * time.Minute

	// healthPath is public so that container and load balancer probes do not need
	// credentials. It reports only that the process is running, never anything
	// about the cluster.
	healthPath = "/healthz"
	// docsPath serves the Scalar API reference. It is public because it is a
	// static rendering of the OpenAPI document: it describes the API's shape but
	// exposes no cluster state, and holding it back would not protect anything a
	// caller could not infer by probing for 401s. Every operation it documents
	// still requires the bearer token.
	docsPath = "/docs"
)

// sseHeartbeatInterval is how often an idle event stream emits a comment. See
// streamSSE for why the heartbeat is load-bearing rather than cosmetic. It is a
// variable only so that tests do not have to wait for it.
var sseHeartbeatInterval = 15 * time.Second

type cappedBuffer struct {
	buffer    bytes.Buffer
	limit     int
	truncated bool
}

func (b *cappedBuffer) Write(data []byte) (int, error) {
	originalLength := len(data)
	remaining := b.limit - b.buffer.Len()
	if len(data) > remaining {
		b.truncated = true
	}
	if remaining > 0 {
		if len(data) > remaining {
			data = data[:remaining]
		}
		_, _ = b.buffer.Write(data)
	}
	return originalLength, nil
}

func (b *cappedBuffer) String() string { return b.buffer.String() }

func (b *cappedBuffer) Truncated() bool { return b.truncated }

// Backend is the narrow, typed subset of Uncloud's client bindings used by the
// HTTP API. *client.Client satisfies this interface, while keeping the HTTP
// handlers easy to test without a running daemon.
type Backend interface {
	Ready(context.Context) error
	ClusterDiagnostics(context.Context) (ClusterDiagnosticsResponse, error)
	ListCaddyConfigs(context.Context) (CaddyConfigsResponse, error)
	ListCaddyCertificates(context.Context, string) (CaddyCertificatesResponse, error)

	ListMachines(context.Context, *api.MachineFilter) ([]api.MachineMember, error)
	InspectMachine(context.Context, string) (api.MachineMember, error)
	RenameMachine(context.Context, string, string) (MachineInfoResponse, error)

	ListServices(context.Context) ([]api.Service, error)
	InspectService(context.Context, string) (api.Service, error)
	RunService(context.Context, api.ServiceSpec) (api.RunServiceResponse, error)
	ServiceLogs(context.Context, string, api.ServiceLogsOptions) (api.Service, <-chan api.ServiceLogEntry, error)
	MachineLogs(context.Context, string, api.ServiceLogsOptions) (<-chan api.ServiceLogEntry, error)
	RemoveService(context.Context, string) error
	StopService(context.Context, string, container.StopOptions) error
	StartService(context.Context, string) error
	InspectContainer(context.Context, string, string) (api.MachineServiceContainer, error)
	StartContainer(context.Context, string, string) error
	StopContainer(context.Context, string, string, container.StopOptions) error
	RemoveContainer(context.Context, string, string, container.RemoveOptions) error
	ExecContainer(context.Context, string, string, api.ExecOptions) (int, error)
	ExecMachine(context.Context, string, api.ExecOptions) (int, error)

	ListVolumes(context.Context, *api.VolumeFilter) ([]api.MachineVolume, error)
	CreateVolume(context.Context, string, volume.CreateOptions) (api.MachineVolume, error)
	RemoveVolume(context.Context, string, string, bool) error
	ListVolumeAttachments(context.Context) ([]VolumeAttachmentResponse, error)

	ListImages(context.Context, api.ImageFilter) ([]api.MachineImages, error)
	InspectImage(context.Context, string) ([]api.MachineImage, error)
	InspectRemoteImage(context.Context, string) ([]RemoteImageResponse, error)
	InspectImageUpdate(context.Context, string) ([]ImageUpdateResponse, error)
	GetDomain(context.Context) (api.ClusterDomain, error)
	SetClusterDomain(context.Context, string) error
	ClearClusterDomain(context.Context) error

	DeployCompose(context.Context, ComposeDeployment) (<-chan DeployComposeEvent, error)
}

// Config controls HTTP-only behavior. Cluster connection setup belongs to the
// standalone command in cmd/sidecar.
type Config struct {
	// AuthToken is the bearer token required by every route except /healthz. It
	// is mandatory: the API executes commands as root on every cluster machine,
	// so an unauthenticated instance is a remote root shell for anyone who can
	// reach the listen address.
	AuthToken string
	// AllowedOrigins is a comma-separated list accepted by Fiber's CORS
	// middleware. Leave it empty to disable CORS middleware.
	AllowedOrigins string
	// MachineID identifies the Uncloud machine hosting this sidecar. Global
	// Uncloud services receive this value through UNCLOUD_MACHINE_ID.
	MachineID string
	// RequestTimeout bounds non-streaming, non-exec requests.
	// DefaultRequestTimeout is used when it is zero.
	RequestTimeout time.Duration
	// ExecTimeout bounds container and host command execution.
	// DefaultExecTimeout is used when it is zero.
	ExecTimeout time.Duration
	// MetricsHTTPClient allows the local metrics transport to be replaced in
	// tests. A client with a five-second timeout is used when it is nil.
	MetricsHTTPClient *http.Client
}

// Server is the standalone Fiber HTTP API for Uncloud.
type Server struct {
	backend        Backend
	app            *fiber.App
	tokenDigest    [sha256.Size]byte
	machineID      string
	requestTimeout time.Duration
	execTimeout    time.Duration
	metricsClient  *http.Client
	openapiJSON    []byte
	openapiYAML    []byte
	scalarHTML     string
}

// New creates a Fiber server backed by Uncloud's typed client bindings.
func New(backend Backend, cfg Config) (*Server, error) {
	if backend == nil {
		return nil, errors.New("HTTP API backend must not be nil")
	}
	if strings.TrimSpace(cfg.AuthToken) == "" {
		return nil, errors.New("HTTP API auth token must not be empty")
	}

	metricsClient := cfg.MetricsHTTPClient
	if metricsClient == nil {
		metricsClient = &http.Client{Timeout: metricsClientTimeout}
	}
	requestTimeout := cfg.RequestTimeout
	if requestTimeout <= 0 {
		requestTimeout = DefaultRequestTimeout
	}
	execTimeout := cfg.ExecTimeout
	if execTimeout <= 0 {
		execTimeout = DefaultExecTimeout
	}

	s := &Server{
		backend:        backend,
		tokenDigest:    sha256.Sum256([]byte(cfg.AuthToken)),
		machineID:      strings.TrimSpace(cfg.MachineID),
		requestTimeout: requestTimeout,
		execTimeout:    execTimeout,
		metricsClient:  metricsClient,
	}
	s.app = fiber.New(fiber.Config{
		DisableStartupMessage: true,
		BodyLimit:             maxRequestBodyBytes,
		ReadTimeout:           readTimeout,
		IdleTimeout:           idleTimeout,
		// WriteTimeout is deliberately unset: it is a connection-wide deadline in
		// fasthttp and would terminate healthy long-lived event streams.
		ErrorHandler: errorHandler,
	})
	s.app.Use(recover.New(recover.Config{EnableStackTrace: false}))
	if cfg.AllowedOrigins != "" {
		s.app.Use(cors.New(cors.Config{
			AllowOrigins: cfg.AllowedOrigins,
			AllowHeaders: "Origin, Content-Type, Accept, Authorization",
		}))
	}
	s.app.Use(s.requireBearerToken)
	s.app.Use(s.withRequestDeadline)

	humaAPI := newAPI(s.app)
	s.registerOperations(humaAPI)

	var err error
	if s.openapiJSON, err = json.Marshal(humaAPI.OpenAPI()); err != nil {
		return nil, fmt.Errorf("marshal OpenAPI document: %w", err)
	}
	if s.openapiYAML, err = humaAPI.OpenAPI().YAML(); err != nil {
		return nil, fmt.Errorf("marshal OpenAPI document as YAML: %w", err)
	}
	s.scalarHTML, err = scalargo.NewV2(
		scalargo.WithSpecBytes(s.openapiJSON),
		scalargo.WithMetaDataOpts(scalargo.WithTitle("Uncloud API")),
		scalargo.WithDarkMode(),
	)
	if err != nil {
		return nil, fmt.Errorf("render Scalar API reference: %w", err)
	}
	s.app.Get("/openapi.json", s.openapi)
	s.app.Get("/openapi.yaml", s.openapiYAMLDocument)
	s.app.Get(docsPath, s.scalar)
	s.app.Get(docsPath+"/*", s.scalar)
	return s, nil
}

// requireBearerToken rejects every request that does not carry the configured
// bearer token. Only the routes listed by isPublicPath are exempt.
func (s *Server) requireBearerToken(c *fiber.Ctx) error {
	if isPublicPath(c.Path()) {
		return c.Next()
	}

	token, ok := bearerToken(c.Get(fiber.HeaderAuthorization))
	if !ok || !s.tokenMatches(token) {
		c.Set(fiber.HeaderWWWAuthenticate, `Bearer realm="uncloud sidecar"`)
		return c.Status(fiber.StatusUnauthorized).JSON(ErrorResponse{Message: "a valid bearer token is required"})
	}
	return c.Next()
}

// isPublicPath reports whether a route is served without credentials. The set is
// deliberately tiny: every other route can read or mutate cluster state, and the
// API executes commands as root on every machine.
//
// The comparison is exact, so a request whose case differs from the registered
// route (Fiber routes case-insensitively by default) is rejected rather than
// admitted. That is the safe direction to be wrong in.
func isPublicPath(path string) bool {
	switch {
	case path == healthPath:
		return true
	case path == docsPath, strings.HasPrefix(path, docsPath+"/"):
		return true
	default:
		return false
	}
}

// tokenMatches compares digests rather than the raw tokens so that neither the
// comparison time nor the token length leaks.
func (s *Server) tokenMatches(token string) bool {
	digest := sha256.Sum256([]byte(token))
	return subtle.ConstantTimeCompare(digest[:], s.tokenDigest[:]) == 1
}

func bearerToken(header string) (string, bool) {
	const prefix = "Bearer "

	if len(header) < len(prefix) || !strings.EqualFold(header[:len(prefix)], prefix) {
		return "", false
	}
	token := strings.TrimSpace(header[len(prefix):])
	return token, token != ""
}

// withRequestDeadline binds handlers to a deadline. Handlers that must outlive
// it (event streams and command execution) detach explicitly through
// streamContext and execContext.
func (s *Server) withRequestDeadline(c *fiber.Ctx) error {
	ctx, cancel := context.WithTimeout(c.UserContext(), s.requestTimeout)
	defer cancel()

	c.SetUserContext(ctx)
	return c.Next()
}

// errorHandler answers errors raised by Fiber itself, such as unknown routes
// and oversized bodies. Operation errors are shaped by newError instead.
func errorHandler(c *fiber.Ctx, err error) error {
	statusCode := fiber.StatusInternalServerError
	var fiberErr *fiber.Error
	if errors.As(err, &fiberErr) {
		statusCode = fiberErr.Code
	}
	return c.Status(statusCode).JSON(ErrorResponse{Message: err.Error()})
}

// App returns the configured Fiber application. It is useful for embedding the
// API in another process and for in-memory HTTP tests.
func (s *Server) App() *fiber.App {
	return s.app
}

type idInput struct {
	ID string `path:"id"`
}

// ContainerInput and LogsQuery are embedded in other inputs. They are exported
// only because Huma skips the parameters of unexported embedded structs.
type ContainerInput struct {
	ID        string `path:"id" doc:"Service name or ID."`
	Container string `path:"container" doc:"Container name or ID."`
}

type listCaddyCertificatesInput struct {
	Machine string `query:"machine" doc:"Machine name or ID whose store replica is read. Defaults to the connected machine."`
}

type listMachinesInput struct {
	Available bool   `query:"available" doc:"Only return machines that are not down."`
	Names     string `query:"names" doc:"Comma-separated machine names or IDs."`
}

type LogsQuery struct {
	Follow     bool   `query:"follow" doc:"Keep the connection open for new log entries."`
	Tail       int    `query:"tail" minimum:"-1" doc:"Number of recent lines to return. Use -1 for all lines."`
	Since      string `query:"since" doc:"Show logs since this Docker timestamp."`
	Until      string `query:"until" doc:"Show logs until this Docker timestamp."`
	Containers string `query:"containers" doc:"Comma-separated service container names or IDs."`
}

type serviceLogsInput struct {
	ID string `path:"id"`
	LogsQuery
	Machines string `query:"machines" doc:"Comma-separated machine names or IDs."`
}

type machineLogsInput struct {
	ID      string `path:"id"`
	Service string `query:"service" required:"true" doc:"System service name, such as uncloud or docker."`
	LogsQuery
}

type listVolumesInput struct {
	Driver   string `query:"driver" doc:"Filter by Docker volume driver."`
	Machines string `query:"machines" doc:"Comma-separated machine names or IDs."`
	Names    string `query:"names" doc:"Comma-separated volume names."`
}

type removeVolumeInput struct {
	Machine string `path:"machine"`
	Volume  string `path:"volume"`
}

type listImagesInput struct {
	Machines string `query:"machines" doc:"Comma-separated machine names or IDs."`
	Name     string `query:"name" doc:"Image name or wildcard pattern."`
}

type bodyInput[T any] struct {
	Body T
}

type renameMachineInput struct {
	ID   string `path:"id"`
	Body RenameMachineRequest
}

type machineExecInput struct {
	ID   string `path:"id"`
	Body MachineExecRequest
}

type containerActionInput struct {
	ContainerInput
	Body ContainerActionRequest
}

type execContainerInput struct {
	ContainerInput
	Body ExecContainerRequest
}

type readinessOutput struct {
	Status int
	Body   ReadinessResponse
}

type metricsOutput struct {
	Status       int
	ContentType  string `header:"Content-Type"`
	CacheControl string `header:"Cache-Control"`
	Body         []byte
}

func (s *Server) registerOperations(humaAPI huma.API) {
	register(humaAPI, huma.Operation{
		OperationID: "health", Method: http.MethodGet, Path: healthPath,
		Summary: "Health check", Tags: []string{"health"}, Security: publicOperation,
	}, s.health)
	register(humaAPI, huma.Operation{
		OperationID: "readiness", Method: http.MethodGet, Path: "/readyz",
		Summary: "Uncloud readiness check", Tags: []string{"health"},
		Responses: map[string]*huma.Response{
			"503": {Description: "The Uncloud control plane is unreachable", Content: map[string]*huma.MediaType{
				"application/json": {Schema: humaAPI.OpenAPI().Components.Schemas.Schema(
					reflect.TypeFor[ReadinessResponse](), true, "")},
			}},
		},
	}, s.ready)
	register(humaAPI, huma.Operation{
		OperationID: "internalMetrics", Method: http.MethodGet, Path: "/ucinternal/metrics",
		Summary: "Proxy the local Uncloud daemon's Prometheus metrics", Tags: []string{"cluster"},
		Errors: []int{http.StatusBadGateway, http.StatusServiceUnavailable},
		Responses: map[string]*huma.Response{
			"200": {Description: "Prometheus exposition format", Content: map[string]*huma.MediaType{
				"text/plain": {Schema: &huma.Schema{Type: huma.TypeString}},
			}},
		},
	}, s.ucInternalMetrics)

	register(humaAPI, huma.Operation{
		OperationID: "getDomain", Method: http.MethodGet, Path: "/api/v1/cluster/domain",
		Summary: "Get cluster domain", Tags: []string{"cluster"},
	}, s.getDomain)
	register(humaAPI, huma.Operation{
		OperationID: "setDomain", Method: http.MethodPut, Path: "/api/v1/cluster/domain",
		Summary: "Set an externally managed cluster domain", Tags: []string{"cluster"},
		Description: "Requires Uncloud 0.21+. Returns 409 when a domain is already configured; clear it first.",
		Errors:      []int{http.StatusConflict},
	}, s.setDomain)
	register(humaAPI, huma.Operation{
		OperationID: "clearDomain", Method: http.MethodDelete, Path: "/api/v1/cluster/domain",
		Summary: "Clear the cluster domain", Tags: []string{"cluster"},
		Description: "Unsets an external domain or releases a domain reserved in Uncloud DNS. " +
			"Uncloud DNS cannot give a released name back yet, so it only forgets it in the cluster store.",
	}, s.clearDomain)
	register(humaAPI, huma.Operation{
		OperationID: "clusterDiagnostics", Method: http.MethodGet, Path: "/api/v1/cluster/diagnostics",
		Summary: "Inspect cluster health", Tags: []string{"cluster"},
	}, s.clusterDiagnostics)
	register(humaAPI, huma.Operation{
		OperationID: "listCaddyConfigs", Method: http.MethodGet, Path: "/api/v1/caddy/configs",
		Summary: "List active Caddy configurations", Tags: []string{"cluster"},
	}, s.listCaddyConfigs)
	register(humaAPI, huma.Operation{
		OperationID: "listCaddyCertificates", Method: http.MethodGet, Path: "/api/v1/caddy/certificates",
		Summary: "List certificates in Caddy's cluster storage", Tags: []string{"cluster"},
		Description: "Requires Uncloud 0.21+ and a Caddy image with the caddy-uncloud storage module configured (`storage uncloud`); " +
			"with the default image Caddy stores certificates locally and this list is empty. " +
			"Lists what is stored, not what Caddy serves, and may include expired certificates. Private keys are never read.",
	}, s.listCaddyCertificates)

	register(humaAPI, huma.Operation{
		OperationID: "listMachines", Method: http.MethodGet, Path: "/api/v1/machines",
		Summary: "List machines", Tags: []string{"machines"},
	}, s.listMachines)
	register(humaAPI, huma.Operation{
		OperationID: "inspectMachine", Method: http.MethodGet, Path: "/api/v1/machines/{id}",
		Summary: "Inspect a machine", Tags: []string{"machines"},
	}, s.inspectMachine)
	register(humaAPI, huma.Operation{
		OperationID: "renameMachine", Method: http.MethodPatch, Path: "/api/v1/machines/{id}",
		Summary: "Rename a machine", Tags: []string{"machines"},
	}, s.renameMachine)
	register(humaAPI, huma.Operation{
		OperationID: "execMachine", Method: http.MethodPost, Path: "/api/v1/machines/{id}/exec",
		Summary: "Execute a host command", Tags: []string{"machines"},
	}, s.execMachine)
	register(humaAPI, huma.Operation{
		OperationID: "streamMachineExec", Method: http.MethodPost, Path: "/api/v1/machines/{id}/exec/stream",
		Summary: "Stream a host command", Tags: []string{"machines"},
		Responses: eventStreamResponse(humaAPI, "Server-Sent host command events", MachineExecEvent{}),
	}, s.streamMachineExec)
	register(humaAPI, huma.Operation{
		OperationID: "machineLogs", Method: http.MethodGet, Path: "/api/v1/machines/{id}/logs",
		Summary: "Stream machine service logs", Tags: []string{"machines"},
		Responses: eventStreamResponse(humaAPI, "Server-Sent log events", LogEventResponse{}),
	}, s.machineLogs)

	register(humaAPI, huma.Operation{
		OperationID: "listServices", Method: http.MethodGet, Path: "/api/v1/services",
		Summary: "List services", Tags: []string{"services"},
	}, s.listServices)
	register(humaAPI, huma.Operation{
		OperationID: "runService", Method: http.MethodPost, Path: "/api/v1/services",
		Summary: "Deploy a service", Tags: []string{"services"}, DefaultStatus: http.StatusCreated,
	}, s.runService)
	register(humaAPI, huma.Operation{
		OperationID: "deployCompose", Method: http.MethodPost, Path: "/api/v1/services/deploy/compose",
		Summary: "Deploy services from a Compose file", Tags: []string{"services"},
		Errors:    []int{http.StatusRequestEntityTooLarge},
		Responses: eventStreamResponse(humaAPI, "Server-Sent deployment events", DeployComposeEvent{}),
	}, s.deployCompose)
	register(humaAPI, huma.Operation{
		OperationID: "inspectService", Method: http.MethodGet, Path: "/api/v1/services/{id}",
		Summary: "Inspect a service", Tags: []string{"services"},
	}, s.inspectService)
	register(humaAPI, huma.Operation{
		OperationID: "removeService", Method: http.MethodDelete, Path: "/api/v1/services/{id}",
		Summary: "Remove a service", Tags: []string{"services"},
	}, s.removeService)
	register(humaAPI, huma.Operation{
		OperationID: "serviceLogs", Method: http.MethodGet, Path: "/api/v1/services/{id}/logs",
		Summary: "Stream service logs", Tags: []string{"services"},
		Responses: eventStreamResponse(humaAPI, "Server-Sent log events", LogEventResponse{}),
	}, s.serviceLogs)
	register(humaAPI, huma.Operation{
		OperationID: "startService", Method: http.MethodPost, Path: "/api/v1/services/{id}/start",
		Summary: "Start a service", Tags: []string{"services"},
	}, s.startService)
	register(humaAPI, huma.Operation{
		OperationID: "stopService", Method: http.MethodPost, Path: "/api/v1/services/{id}/stop",
		Summary: "Stop a service", Tags: []string{"services"},
	}, s.stopService)
	register(humaAPI, huma.Operation{
		OperationID: "inspectContainer", Method: http.MethodGet, Path: "/api/v1/services/{id}/containers/{container}",
		Summary: "Inspect a service container", Tags: []string{"services"},
	}, s.inspectContainer)
	register(humaAPI, huma.Operation{
		OperationID: "containerAction", Method: http.MethodPost, Path: "/api/v1/services/{id}/containers/{container}/actions",
		Summary: "Control a service container", Tags: []string{"services"},
	}, s.containerAction)
	register(humaAPI, huma.Operation{
		OperationID: "execContainer", Method: http.MethodPost, Path: "/api/v1/services/{id}/containers/{container}/exec",
		Summary: "Execute a command in a service container", Tags: []string{"services"},
	}, s.execContainer)

	register(humaAPI, huma.Operation{
		OperationID: "listVolumes", Method: http.MethodGet, Path: "/api/v1/volumes",
		Summary: "List volumes", Tags: []string{"volumes"},
	}, s.listVolumes)
	register(humaAPI, huma.Operation{
		OperationID: "createVolume", Method: http.MethodPost, Path: "/api/v1/volumes",
		Summary: "Create a volume", Tags: []string{"volumes"}, DefaultStatus: http.StatusCreated,
	}, s.createVolume)
	register(humaAPI, huma.Operation{
		OperationID: "listVolumeAttachments", Method: http.MethodGet, Path: "/api/v1/volumes/attachments",
		Summary: "List volume attachments", Tags: []string{"volumes"},
	}, s.listVolumeAttachments)
	register(humaAPI, huma.Operation{
		OperationID: "removeVolume", Method: http.MethodDelete, Path: "/api/v1/machines/{machine}/volumes/{volume}",
		Summary: "Remove a volume", Tags: []string{"volumes"},
	}, s.removeVolume)

	register(humaAPI, huma.Operation{
		OperationID: "listImages", Method: http.MethodGet, Path: "/api/v1/images",
		Summary: "List images", Tags: []string{"images"},
	}, s.listImages)
	register(humaAPI, huma.Operation{
		OperationID: "inspectImage", Method: http.MethodGet, Path: "/api/v1/images/{id}",
		Summary: "Inspect an image", Tags: []string{"images"},
	}, s.inspectImage)
	register(humaAPI, huma.Operation{
		OperationID: "inspectRemoteImage", Method: http.MethodGet, Path: "/api/v1/images/{id}/remote",
		Summary: "Inspect an image in its remote registry", Tags: []string{"images"},
	}, s.inspectRemoteImage)
	register(humaAPI, huma.Operation{
		OperationID: "inspectImageUpdate", Method: http.MethodGet, Path: "/api/v1/images/{id}/update",
		Summary: "Check an image for updates", Tags: []string{"images"},
	}, s.inspectImageUpdate)
}

func (s *Server) health(context.Context, *struct{}) (*bodyOutput[StatusResponse], error) {
	return reply(StatusResponse{Status: "ok"}), nil
}

func (s *Server) ready(ctx context.Context, _ *struct{}) (*readinessOutput, error) {
	if err := s.backend.Ready(ctx); err != nil {
		return &readinessOutput{
			Status: http.StatusServiceUnavailable,
			Body:   ReadinessResponse{Status: "unavailable", Message: err.Error()},
		}, nil
	}
	return &readinessOutput{Status: http.StatusOK, Body: ReadinessResponse{Status: "ready"}}, nil
}

func (s *Server) ucInternalMetrics(ctx context.Context, _ *struct{}) (*metricsOutput, error) {
	if s.machineID == "" {
		return nil, huma.Error503ServiceUnavailable("local Uncloud machine ID is not configured")
	}

	machine, err := s.backend.InspectMachine(ctx, s.machineID)
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("inspect local Uncloud machine for metrics: " + err.Error())
	}

	machineIP, err := machineMetricsIP(machine)
	if err != nil {
		return nil, err
	}

	targetURL := "http://" + net.JoinHostPort(machineIP.String(), strconv.Itoa(uncloudMetricsPort)) + uncloudMetricsPath
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, fmt.Errorf("create local Uncloud metrics request: %w", err)
	}

	response, err := s.metricsClient.Do(request)
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("fetch local Uncloud metrics: " + err.Error())
	}
	defer response.Body.Close()

	body, err := io.ReadAll(io.LimitReader(response.Body, maxMetricsBytes+1))
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("read local Uncloud metrics: " + err.Error())
	}
	if len(body) > maxMetricsBytes {
		return nil, huma.Error502BadGateway("local Uncloud metrics exceed 16 MiB")
	}

	contentType := response.Header.Get(fiber.HeaderContentType)
	if contentType == "" {
		contentType = fiber.MIMETextPlain + "; charset=utf-8"
	}
	return &metricsOutput{
		Status:       response.StatusCode,
		ContentType:  contentType,
		CacheControl: "no-store",
		Body:         body,
	}, nil
}

func machineMetricsIP(machine api.MachineMember) (netip.Addr, error) {
	// Uncloud's metrics server listens on the machine's IPv4 address (the first
	// usable address in its container subnet), not on the IPv6 management
	// address used by the WireGuard control plane.
	subnet := machine.Network.Subnet
	if !subnet.IsValid() || !subnet.Addr().Is4() {
		return netip.Addr{}, huma.Error503ServiceUnavailable("local Uncloud machine has no cluster IPv4 subnet")
	}

	machineIP := subnet.Masked().Addr().Next()
	if !machineIP.IsValid() || !subnet.Contains(machineIP) {
		return netip.Addr{}, huma.Error503ServiceUnavailable("local Uncloud machine has no usable cluster IPv4 address")
	}
	return machineIP, nil
}

func (s *Server) clusterDiagnostics(ctx context.Context, _ *struct{}) (*bodyOutput[ClusterDiagnosticsResponse], error) {
	diagnostics, err := s.backend.ClusterDiagnostics(ctx)
	if err != nil {
		return nil, err
	}
	return reply(diagnostics), nil
}

func (s *Server) listCaddyConfigs(ctx context.Context, _ *struct{}) (*bodyOutput[CaddyConfigsResponse], error) {
	configs, err := s.backend.ListCaddyConfigs(ctx)
	if err != nil {
		return nil, err
	}
	return reply(configs), nil
}

func (s *Server) listCaddyCertificates(ctx context.Context, input *listCaddyCertificatesInput) (*bodyOutput[CaddyCertificatesResponse], error) {
	certificates, err := s.backend.ListCaddyCertificates(ctx, strings.TrimSpace(input.Machine))
	if err != nil {
		return nil, err
	}
	return reply(certificates), nil
}

func (s *Server) openapi(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, fiber.MIMEApplicationJSON)
	return c.Send(s.openapiJSON)
}

func (s *Server) openapiYAMLDocument(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, "application/yaml; charset=utf-8")
	return c.Send(s.openapiYAML)
}

func (s *Server) scalar(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, fiber.MIMETextHTML+"; charset=utf-8")
	return c.SendString(s.scalarHTML)
}

func (s *Server) getDomain(ctx context.Context, _ *struct{}) (*bodyOutput[DomainResponse], error) {
	domain, err := s.backend.GetDomain(ctx)
	if err != nil {
		return nil, err
	}
	return reply(DomainResponse{Domain: domain.Name, Reserved: domain.Reserved}), nil
}

// setDomain sets an externally managed domain. A configured domain must be
// cleared first; Uncloud answers 409 instead of replacing it.
func (s *Server) setDomain(ctx context.Context, input *bodyInput[SetDomainRequest]) (*bodyOutput[DomainResponse], error) {
	name := strings.TrimSpace(input.Body.Name)
	if name == "" {
		return nil, huma.Error400BadRequest("name must not be empty")
	}

	if err := s.backend.SetClusterDomain(ctx, name); err != nil {
		return nil, err
	}
	return s.getDomain(ctx, nil)
}

func (s *Server) clearDomain(ctx context.Context, _ *struct{}) (*bodyOutput[StatusResponse], error) {
	if err := s.backend.ClearClusterDomain(ctx); err != nil {
		return nil, err
	}
	return reply(StatusResponse{Status: "cleared"}), nil
}

func (s *Server) listMachines(ctx context.Context, input *listMachinesInput) (*bodyOutput[ItemResponse[MachineResponse]], error) {
	machines, err := s.backend.ListMachines(ctx, &api.MachineFilter{
		Available:  input.Available,
		NamesOrIDs: splitQuery(input.Names),
	})
	if err != nil {
		return nil, err
	}
	items := make([]MachineResponse, 0, len(machines))
	for _, machine := range machines {
		items = append(items, machineResponse(machine))
	}
	return reply(ItemResponse[MachineResponse]{Items: items}), nil
}

func (s *Server) inspectMachine(ctx context.Context, input *idInput) (*bodyOutput[MachineResponse], error) {
	machine, err := s.backend.InspectMachine(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	return reply(machineResponse(machine)), nil
}

func (s *Server) renameMachine(ctx context.Context, input *renameMachineInput) (*bodyOutput[MachineInfoResponse], error) {
	name := strings.TrimSpace(input.Body.Name)
	if name == "" {
		return nil, huma.Error400BadRequest("name must not be empty")
	}

	machine, err := s.backend.RenameMachine(ctx, input.ID, name)
	if err != nil {
		return nil, err
	}
	if machine.ID == "" && machine.Name == "" {
		return nil, errors.New("Uncloud returned an empty machine response")
	}
	return reply(machine), nil
}

func (s *Server) listServices(ctx context.Context, _ *struct{}) (*bodyOutput[ItemResponse[ServiceResponse]], error) {
	services, err := s.backend.ListServices(ctx)
	if err != nil {
		return nil, err
	}
	items := make([]ServiceResponse, 0, len(services))
	for _, service := range services {
		items = append(items, serviceResponse(service))
	}
	return reply(ItemResponse[ServiceResponse]{Items: items}), nil
}

func (s *Server) inspectService(ctx context.Context, input *idInput) (*bodyOutput[ServiceResponse], error) {
	service, err := s.backend.InspectService(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	return reply(serviceResponse(service)), nil
}

func (s *Server) serviceLogs(ctx context.Context, input *serviceLogsInput) (*huma.StreamResponse, error) {
	opts := input.LogsQuery.options()
	opts.Machines = splitQuery(input.Machines)

	streamCtx, cancel := streamContext(ctx)
	_, entries, err := s.backend.ServiceLogs(streamCtx, input.ID, opts)
	if err != nil {
		cancel()
		return nil, err
	}
	if entries == nil {
		cancel()
		return nil, errors.New("Uncloud returned an empty service log stream")
	}

	return eventStream(cancel, entries, encodeLogEvent), nil
}

func (s *Server) machineLogs(ctx context.Context, input *machineLogsInput) (*huma.StreamResponse, error) {
	service := strings.TrimSpace(input.Service)
	if service == "" {
		return nil, huma.Error400BadRequest("query parameter \"service\" is required")
	}
	opts := input.LogsQuery.options()
	// The path identifies one machine. Do not allow a query filter to broaden
	// this endpoint to a different set of machines.
	opts.Machines = []string{input.ID}

	streamCtx, cancel := streamContext(ctx)
	entries, err := s.backend.MachineLogs(streamCtx, service, opts)
	if err != nil {
		cancel()
		return nil, err
	}
	if entries == nil {
		cancel()
		return nil, errors.New("Uncloud returned an empty machine log stream")
	}

	return eventStream(cancel, entries, encodeLogEvent), nil
}

func (s *Server) runService(ctx context.Context, input *bodyInput[api.ServiceSpec]) (*bodyOutput[RunServiceResponse], error) {
	response, err := s.backend.RunService(ctx, input.Body)
	if err != nil {
		return nil, err
	}
	return reply(RunServiceResponse{ID: response.ID, Name: response.Name}), nil
}

// deployCompose deploys services from a base64-encoded Compose file, replicating
// the behaviour of the 'uc deploy' command without the interactive build and
// confirmation steps. Deployment progress is streamed as JSON Server-Sent Events.
func (s *Server) deployCompose(ctx context.Context, input *bodyInput[DeployComposeRequest]) (*huma.StreamResponse, error) {
	request := input.Body
	if len(request.Compose) > base64.StdEncoding.EncodedLen(maxComposeFileBytes) {
		return nil, huma.Error413RequestEntityTooLarge("compose file must not exceed 4 MiB")
	}
	content, err := base64.StdEncoding.DecodeString(request.Compose)
	if err != nil {
		return nil, huma.Error400BadRequest("invalid base64-encoded compose file: " + err.Error())
	}
	if len(content) > maxComposeFileBytes {
		return nil, huma.Error413RequestEntityTooLarge("compose file must not exceed 4 MiB")
	}
	if len(bytes.TrimSpace(content)) == 0 {
		return nil, huma.Error400BadRequest("compose file must not be empty")
	}

	streamCtx, cancel := streamContext(ctx)
	events, err := s.backend.DeployCompose(streamCtx, ComposeDeployment{
		Content: string(content),
		Options: request.Options,
	})
	if err != nil {
		cancel()
		return nil, err
	}
	if events == nil {
		cancel()
		return nil, errors.New("Uncloud returned an empty compose deployment stream")
	}

	return eventStream(cancel, events, encodeDeployEvent), nil
}

func (s *Server) startService(ctx context.Context, input *idInput) (*bodyOutput[StatusResponse], error) {
	if err := s.backend.StartService(ctx, input.ID); err != nil {
		return nil, err
	}
	return reply(StatusResponse{Status: "started"}), nil
}

func (s *Server) stopService(ctx context.Context, input *idInput) (*bodyOutput[StatusResponse], error) {
	if err := s.backend.StopService(ctx, input.ID, container.StopOptions{}); err != nil {
		return nil, err
	}
	return reply(StatusResponse{Status: "stopped"}), nil
}

func (s *Server) inspectContainer(ctx context.Context, input *ContainerInput) (*bodyOutput[ServiceContainerResponse], error) {
	serviceContainer, err := s.backend.InspectContainer(ctx, input.ID, input.Container)
	if err != nil {
		return nil, err
	}
	return reply(ServiceContainerResponse{
		MachineID: serviceContainer.MachineID, MachineName: serviceContainer.MachineName,
		Container: serviceContainer.Container,
	}), nil
}

func (s *Server) containerAction(ctx context.Context, input *containerActionInput) (*bodyOutput[StatusResponse], error) {
	serviceID, containerID := input.ID, input.Container

	status := ""
	switch input.Body.Action {
	case "start":
		if err := s.backend.StartContainer(ctx, serviceID, containerID); err != nil {
			return nil, err
		}
		status = "started"
	case "stop":
		if err := s.backend.StopContainer(ctx, serviceID, containerID, container.StopOptions{}); err != nil {
			return nil, err
		}
		status = "stopped"
	case "restart":
		if err := s.backend.StopContainer(ctx, serviceID, containerID, container.StopOptions{}); err != nil {
			return nil, err
		}
		if err := s.backend.StartContainer(ctx, serviceID, containerID); err != nil {
			return nil, err
		}
		status = "restarted"
	case "remove":
		if err := s.backend.RemoveContainer(ctx, serviceID, containerID, container.RemoveOptions{}); err != nil {
			return nil, err
		}
		status = "removed"
	default:
		// The schema's enum rejects anything else before the handler runs.
		return nil, huma.Error400BadRequest("action must be start, stop, restart, or remove")
	}

	return reply(StatusResponse{Status: status}), nil
}

func (s *Server) execContainer(ctx context.Context, input *execContainerInput) (*bodyOutput[ExecContainerResponse], error) {
	request := input.Body
	if err := validateCommand(request.Command); err != nil {
		return nil, err
	}

	stdout := &cappedBuffer{limit: maxExecOutputBytes}
	stderr := &cappedBuffer{limit: maxExecOutputBytes}
	execCtx, cancel := s.execContext(ctx)
	defer cancel()

	exitCode, err := s.backend.ExecContainer(execCtx, input.ID, input.Container, api.ExecOptions{
		Command: request.Command, AttachStdin: request.Stdin != "", AttachStdout: true,
		AttachStderr: !request.TTY, Tty: request.TTY, Stdin: strings.NewReader(request.Stdin),
		Stdout: stdout, Stderr: stderr,
	})
	if err != nil {
		return nil, err
	}
	return reply(ExecContainerResponse{
		ExitCode: exitCode, Stdout: stdout.String(), Stderr: stderr.String(),
		Truncated: stdout.Truncated() || stderr.Truncated(),
	}), nil
}

func (s *Server) removeService(ctx context.Context, input *idInput) (*bodyOutput[StatusResponse], error) {
	if err := s.backend.RemoveService(ctx, input.ID); err != nil {
		return nil, err
	}
	return reply(StatusResponse{Status: "removed"}), nil
}

func (s *Server) listVolumes(ctx context.Context, input *listVolumesInput) (*bodyOutput[ItemResponse[VolumeResponse]], error) {
	volumes, err := s.backend.ListVolumes(ctx, &api.VolumeFilter{
		Driver:   input.Driver,
		Machines: splitQuery(input.Machines),
		Names:    splitQuery(input.Names),
	})
	if err != nil {
		return nil, err
	}
	items := make([]VolumeResponse, 0, len(volumes))
	for _, machineVolume := range volumes {
		items = append(items, volumeResponse(machineVolume))
	}
	return reply(ItemResponse[VolumeResponse]{Items: items}), nil
}

func (s *Server) listVolumeAttachments(ctx context.Context, _ *struct{}) (*bodyOutput[ItemResponse[VolumeAttachmentResponse]], error) {
	attachments, err := s.backend.ListVolumeAttachments(ctx)
	if err != nil {
		return nil, err
	}
	return reply(ItemResponse[VolumeAttachmentResponse]{Items: attachments}), nil
}

func (s *Server) createVolume(ctx context.Context, input *bodyInput[CreateVolumeRequest]) (*bodyOutput[VolumeResponse], error) {
	request := input.Body
	request.Machine = strings.TrimSpace(request.Machine)
	request.Name = strings.TrimSpace(request.Name)
	if request.Machine == "" || request.Name == "" {
		return nil, huma.Error400BadRequest("machine and name are required")
	}

	machineVolume, err := s.backend.CreateVolume(ctx, request.Machine, volume.CreateOptions{
		Name:       request.Name,
		Driver:     request.Driver,
		DriverOpts: request.DriverOpts,
		Labels:     request.Labels,
	})
	if err != nil {
		return nil, err
	}
	return reply(volumeResponse(machineVolume)), nil
}

func (s *Server) removeVolume(ctx context.Context, input *removeVolumeInput) (*bodyOutput[StatusResponse], error) {
	if err := s.backend.RemoveVolume(ctx, input.Machine, input.Volume, false); err != nil {
		return nil, err
	}
	return reply(StatusResponse{Status: "removed"}), nil
}

func (s *Server) listImages(ctx context.Context, input *listImagesInput) (*bodyOutput[ItemResponse[ImageGroupResponse]], error) {
	images, err := s.backend.ListImages(ctx, api.ImageFilter{
		Machines: splitQuery(input.Machines),
		Name:     input.Name,
	})
	if err != nil {
		return nil, err
	}
	items := make([]ImageGroupResponse, 0, len(images))
	for _, machineImages := range images {
		items = append(items, imageGroupResponse(machineImages))
	}
	return reply(ItemResponse[ImageGroupResponse]{Items: items}), nil
}

func (s *Server) inspectImage(ctx context.Context, input *idInput) (*bodyOutput[ItemResponse[MachineImageResponse]], error) {
	images, err := s.backend.InspectImage(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	items := make([]MachineImageResponse, 0, len(images))
	for _, machineImage := range images {
		items = append(items, machineImageResponse(machineImage))
	}
	return reply(ItemResponse[MachineImageResponse]{Items: items}), nil
}

func (s *Server) inspectRemoteImage(ctx context.Context, input *idInput) (*bodyOutput[ItemResponse[RemoteImageResponse]], error) {
	images, err := s.backend.InspectRemoteImage(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	return reply(ItemResponse[RemoteImageResponse]{Items: images}), nil
}

func (s *Server) inspectImageUpdate(ctx context.Context, input *idInput) (*bodyOutput[ItemResponse[ImageUpdateResponse]], error) {
	images, err := s.backend.InspectImageUpdate(ctx, input.ID)
	if err != nil {
		return nil, err
	}
	return reply(ItemResponse[ImageUpdateResponse]{Items: images}), nil
}

// streamContext returns the context for an event stream. It drops the
// per-request deadline set by withRequestDeadline, because the stream keeps
// running after the handler returns. The returned cancel function is owned by
// the stream writer, which calls it when the stream ends.
func streamContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithCancel(context.WithoutCancel(ctx))
}

// execContext bounds a command execution by the configured exec timeout rather
// than the shorter per-request deadline.
func (s *Server) execContext(ctx context.Context) (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.WithoutCancel(ctx), s.execTimeout)
}

func validateCommand(command []string) error {
	if len(command) == 0 {
		return huma.Error400BadRequest("command must not be empty")
	}
	for _, argument := range command {
		if strings.ContainsRune(argument, '\x00') {
			return huma.Error400BadRequest("command arguments must not contain NUL bytes")
		}
	}
	return nil
}

// sseEvent is one encoded Server-Sent Event.
type sseEvent struct {
	name string
	data []byte
}

func encodeSSE(name string, payload any) (sseEvent, error) {
	data, err := json.Marshal(payload)
	if err != nil {
		return sseEvent{}, err
	}
	return sseEvent{name: name, data: data}, nil
}

// eventStream answers an operation with the events from a channel. Huma's sse
// package is not used because it ties each event name to one Go type, while a
// log entry is sent as either "log" or "error", and it has no heartbeat.
func eventStream[T any](
	cancel context.CancelFunc,
	events <-chan T,
	encode func(T) (sseEvent, error),
) *huma.StreamResponse {
	return &huma.StreamResponse{Body: func(ctx huma.Context) {
		streamSSE(humafiber.UnwrapV2(ctx), cancel, events, encode)
	}}
}

// streamSSE writes events until the channel closes, the server shuts down, or
// the client goes away.
//
// The heartbeat is what makes client disconnects observable. fasthttp's
// RequestCtx.Done is closed only when the server itself is shutting down, so a
// dropped connection is detected solely by a failing write. Streams that can sit
// idle for minutes (host exec, compose deploys) would otherwise leak this
// goroutine, the event channel, and the upstream cluster stream until process
// exit.
func streamSSE[T any](
	c *fiber.Ctx,
	cancel context.CancelFunc,
	events <-chan T,
	encode func(T) (sseEvent, error),
) {
	c.Set(fiber.HeaderContentType, "text/event-stream")
	c.Set(fiber.HeaderCacheControl, "no-cache")
	c.Set(fiber.HeaderConnection, "keep-alive")
	c.Set("X-Accel-Buffering", "no")

	serverDone := c.Context().Done()
	c.Context().SetBodyStreamWriter(func(writer *bufio.Writer) {
		defer cancel()

		heartbeat := time.NewTicker(sseHeartbeatInterval)
		defer heartbeat.Stop()

		for {
			select {
			case event, ok := <-events:
				if !ok {
					return
				}
				encoded, err := encode(event)
				if err != nil {
					return
				}
				if writeSSEEvent(writer, encoded) != nil {
					return
				}
			case <-heartbeat.C:
				if writeSSEComment(writer) != nil {
					return
				}
			case <-serverDone:
				return
			}
		}
	})
}

func writeSSEEvent(writer *bufio.Writer, event sseEvent) error {
	if _, err := fmt.Fprintf(writer, "event: %s\ndata: %s\n\n", event.name, event.data); err != nil {
		return err
	}
	return writer.Flush()
}

// writeSSEComment emits an SSE comment, which clients ignore.
func writeSSEComment(writer *bufio.Writer) error {
	if _, err := writer.WriteString(": heartbeat\n\n"); err != nil {
		return err
	}
	return writer.Flush()
}

func (q LogsQuery) options() api.ServiceLogsOptions {
	return api.ServiceLogsOptions{
		Follow:     q.Follow,
		Tail:       q.Tail,
		Since:      q.Since,
		Until:      q.Until,
		Containers: splitQuery(q.Containers),
	}
}

func serviceLogEvent(entry api.ServiceLogEntry) LogEventResponse {
	return LogEventResponse{
		Metadata:  logMetadataResponse(entry.Metadata),
		Stream:    logStreamName(entry.Stream),
		Timestamp: entry.Timestamp,
		Message:   string(entry.Message),
		Error:     errorString(entry.Err),
	}
}

func logMetadataResponse(metadata api.ServiceLogEntryMetadata) *LogMetadataResponse {
	return &LogMetadataResponse{
		ServiceID:   metadata.ServiceID,
		ServiceName: metadata.ServiceName,
		ContainerID: metadata.ContainerID,
		MachineID:   metadata.MachineID,
		MachineName: metadata.MachineName,
		Hook:        metadata.Hook,
	}
}

func logStreamName(stream api.LogStreamType) string {
	switch stream {
	case api.LogStreamStdout:
		return "stdout"
	case api.LogStreamStderr:
		return "stderr"
	case api.LogStreamHeartbeat:
		return "heartbeat"
	default:
		return "unknown"
	}
}

func errorString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

func encodeDeployEvent(event DeployComposeEvent) (sseEvent, error) {
	name := event.Type
	if name == "" {
		name = "message"
	}
	return encodeSSE(name, event)
}

func encodeLogEvent(entry api.ServiceLogEntry) (sseEvent, error) {
	event := serviceLogEvent(entry)
	name := "log"
	if event.Error != "" {
		name = "error"
	}
	return encodeSSE(name, event)
}

func splitQuery(value string) []string {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	parts := strings.Split(value, ",")
	values := make([]string, 0, len(parts))
	for _, part := range parts {
		if value := strings.TrimSpace(part); value != "" {
			values = append(values, value)
		}
	}
	return values
}
