package httpapi

import (
	"encoding/base64"
	"encoding/hex"
	"time"

	"github.com/docker/docker/api/types/image"
	"github.com/docker/docker/api/types/volume"
	"github.com/psviderski/uncloud/pkg/api"
)

// ItemResponse wraps collection responses in a stable object shape. Keeping the
// collection under items leaves room for pagination metadata without changing
// the response from an array to an object later.
type ItemResponse[T any] struct {
	Items []T `json:"items"`
}

// ErrorResponse is returned for every failed HTTP request. Its status is the
// HTTP status code, set when the error is raised (see newError).
type ErrorResponse struct {
	status  int
	Message string `json:"error"`
}

// StatusResponse is returned by operations that do not have a resource body.
type StatusResponse struct {
	Status string `json:"status"`
}

// DomainResponse contains the cluster's DNS domain. Reserved is true when the
// domain is managed by Uncloud DNS and false when it was set externally.
type DomainResponse struct {
	Domain   string `json:"domain"`
	Reserved bool   `json:"reserved"`
}

// SetDomainRequest sets an externally managed cluster domain.
type SetDomainRequest struct {
	Name string `json:"name"`
}

// ReadinessResponse reports whether the sidecar can reach the Uncloud control plane.
type ReadinessResponse struct {
	Status  string `json:"status"`
	Message string `json:"message,omitempty"`
}

// ClusterDiagnosticsResponse is a read-only health snapshot assembled from every machine.
type ClusterDiagnosticsResponse struct {
	Status       string                      `json:"status" enum:"healthy,degraded"`
	Issues       []string                    `json:"issues"`
	Machines     []DiagnosticMachineResponse `json:"machines"`
	Links        []ClusterLinkResponse       `json:"links"`
	VersionDrift bool                        `json:"versionDrift"`
}

type DiagnosticMachineResponse struct {
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	State         string             `json:"state"`
	DaemonVersion string             `json:"daemonVersion,omitempty"`
	DockerVersion string             `json:"dockerVersion,omitempty"`
	StoreVersion  api.StoreVersion   `json:"storeVersion,omitempty"`
	WireGuard     *WireGuardResponse `json:"wireGuard,omitempty"`
	Error         string             `json:"error,omitempty"`
}

type ClusterLinkResponse struct {
	From          string  `json:"from"`
	To            string  `json:"to"`
	MedianMs      float64 `json:"medianMs"`
	StandardDevMs float64 `json:"standardDevMs"`
}

type WireGuardResponse struct {
	InterfaceName string                  `json:"interfaceName"`
	ListenPort    int32                   `json:"listenPort"`
	Peers         []WireGuardPeerResponse `json:"peers"`
}

type WireGuardPeerResponse struct {
	Endpoint        string    `json:"endpoint,omitempty"`
	LastHandshakeAt time.Time `json:"lastHandshakeAt,omitempty"`
	ReceiveBytes    int64     `json:"receiveBytes"`
	TransmitBytes   int64     `json:"transmitBytes"`
	AllowedIPs      []string  `json:"allowedIps"`
}

type CaddyConfigResponse struct {
	MachineID   string    `json:"machineId"`
	MachineName string    `json:"machineName"`
	Caddyfile   string    `json:"caddyfile,omitempty"`
	ModifiedAt  time.Time `json:"modifiedAt,omitzero"`
	SHA256      string    `json:"sha256,omitempty"`
	// LastReconciliationError is why the machine last failed to load a
	// generated config. Caddy keeps serving the previous config meanwhile.
	LastReconciliationError string `json:"lastReconciliationError,omitempty" doc:"Why the machine last failed to load a generated config."`
	Error                   string `json:"error,omitempty"`
}

type CaddyConfigsResponse struct {
	Items []CaddyConfigResponse `json:"items"`
	Drift bool                  `json:"drift"`
}

// CaddyCertificatesResponse lists certificates in Caddy's cluster storage.
// Errors holds stored certificates that could not be parsed.
type CaddyCertificatesResponse struct {
	Items  []CaddyCertificateResponse `json:"items"`
	Errors []string                   `json:"errors" doc:"Stored certificates that could not be parsed."`
}

type CaddyCertificateResponse struct {
	SAN                string                        `json:"san"`
	DNSNames           []string                      `json:"dnsNames"`
	Issuer             string                        `json:"issuer"`
	IssuerOrganization string                        `json:"issuerOrganization,omitempty"`
	SerialNumber       string                        `json:"serialNumber" doc:"Hexadecimal serial number."`
	NotBefore          time.Time                     `json:"notBefore"`
	NotAfter           time.Time                     `json:"notAfter"`
	SHA256             string                        `json:"sha256" doc:"SHA-256 fingerprint of the leaf certificate."`
	ACME               *CaddyCertificateACMEResponse `json:"acme,omitempty"`
}

// CaddyCertificateACMEResponse is the ACME metadata Caddy stored with a
// certificate. The renewal window is the CA's suggestion, not a schedule.
type CaddyCertificateACMEResponse struct {
	CA                 string    `json:"ca"`
	URL                string    `json:"url"`
	RenewalWindowStart time.Time `json:"renewalWindowStart,omitzero"`
	RenewalWindowEnd   time.Time `json:"renewalWindowEnd,omitzero"`
}

type RemoteImageResponse struct {
	MachineID          string `json:"machineId,omitempty"`
	MachineName        string `json:"machineName,omitempty"`
	CanonicalReference string `json:"canonicalReference,omitempty"`
	Digest             string `json:"digest,omitempty"`
	Error              string `json:"error,omitempty"`
}

type ImageUpdateResponse struct {
	MachineID       string   `json:"machineId,omitempty"`
	MachineName     string   `json:"machineName,omitempty"`
	ImageID         string   `json:"imageId,omitempty"`
	LocalDigests    []string `json:"localDigests"`
	RemoteDigest    string   `json:"remoteDigest,omitempty"`
	UpdateAvailable *bool    `json:"updateAvailable,omitempty"`
	Error           string   `json:"error,omitempty"`
}

type VolumeAttachmentResponse struct {
	MachineID     string `json:"machineId"`
	MachineName   string `json:"machineName"`
	VolumeName    string `json:"volumeName"`
	Attached      bool   `json:"attached"`
	ServiceID     string `json:"serviceId,omitempty"`
	ServiceName   string `json:"serviceName,omitempty"`
	ContainerID   string `json:"containerId,omitempty"`
	ContainerName string `json:"containerName,omitempty"`
	Destination   string `json:"destination,omitempty"`
}

type ContainerActionRequest struct {
	Action string `json:"action" enum:"start,stop,restart,remove"`
}

type ExecContainerRequest struct {
	Command []string `json:"command"`
	Stdin   string   `json:"stdin,omitempty"`
	TTY     bool     `json:"tty,omitempty"`
}

type ExecContainerResponse struct {
	ExitCode  int    `json:"exitCode"`
	Stdout    string `json:"stdout"`
	Stderr    string `json:"stderr"`
	Truncated bool   `json:"truncated"`
}

// MachineExecRequest describes a command to run on a machine's host operating system.
type MachineExecRequest struct {
	Command []string `json:"command"`
	Stdin   string   `json:"stdin,omitempty"`
}

// MachineExecResponse contains the completed result of a host command.
type MachineExecResponse struct {
	MachineID   string `json:"machineId"`
	MachineName string `json:"machineName"`
	ExitCode    int    `json:"exitCode"`
	Stdout      string `json:"stdout"`
	Stderr      string `json:"stderr"`
	Truncated   bool   `json:"truncated"`
}

// MachineExecEvent is emitted by the streaming host command endpoint.
// Type is one of stdout, stderr, complete, or error.
type MachineExecEvent struct {
	Type     string `json:"type" enum:"stdout,stderr,complete,error"`
	Data     string `json:"data,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

// RenameMachineRequest is the request body for changing a machine name.
type RenameMachineRequest struct {
	Name string `json:"name"`
}

// CreateVolumeRequest describes a named Docker volume to create on a machine.
type CreateVolumeRequest struct {
	Machine    string            `json:"machine"`
	Name       string            `json:"name"`
	Driver     string            `json:"driver,omitempty"`
	DriverOpts map[string]string `json:"driverOpts,omitempty"`
	Labels     map[string]string `json:"labels,omitempty"`
}

// RunServiceResponse is returned after a service deployment has completed.
type RunServiceResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// DeployComposeRequest is the request body for deploying services from a Compose file.
// The Compose file content is provided base64-encoded to keep the JSON body text-safe.
type DeployComposeRequest struct {
	Compose string               `json:"compose" format:"byte" doc:"Base64-encoded Docker Compose file content."`
	Options DeployComposeOptions `json:"options,omitempty"`
}

// ComposeDeployment is the decoded form of DeployComposeRequest passed to the
// backend. It is a separate type so that the encoding of the wire format cannot
// be confused with the plain Compose content the backend expects.
type ComposeDeployment struct {
	// Content is the decoded Compose file.
	Content string
	Options DeployComposeOptions
}

// DeployComposeOptions mirrors the flags of the 'uc deploy' command.
type DeployComposeOptions struct {
	// Profiles enables one or more Compose profiles.
	Profiles []string `json:"profiles,omitempty" doc:"Compose profiles to enable."`
	// Services selects the Compose services to deploy. Dependencies are included automatically.
	Services []string `json:"services,omitempty" doc:"Compose services to deploy. Dependencies are included automatically."`
	// Recreate forces the recreation of containers even if their configuration and image haven't changed.
	Recreate bool `json:"recreate,omitempty" doc:"Recreate containers even if their configuration and image haven't changed."`
	// SkipHealth skips the monitoring period and health checks after starting new containers.
	SkipHealth bool `json:"skipHealth,omitempty" doc:"Skip the monitoring period and health checks after starting new containers."`
}

// DeployComposeEvent is streamed as a Server-Sent Event while a Compose deployment runs.
type DeployComposeEvent struct {
	Type string `json:"type" enum:"plan,progress,complete,error"`

	Operations []DeployComposePlanOperation `json:"operations,omitempty"`

	ID         string `json:"id,omitempty"`
	ParentID   string `json:"parentId,omitempty"`
	Phase      string `json:"phase,omitempty" enum:"working,done,warning,error,unknown"`
	StatusText string `json:"statusText,omitempty"`
	Text       string `json:"text,omitempty"`
	Percent    int    `json:"percent,omitempty"`
	Current    int64  `json:"current,omitempty"`
	Total      int64  `json:"total,omitempty"`

	DeployStatus string `json:"status,omitempty"`
	Error        string `json:"error,omitempty"`
}

// DeployComposePlanOperation describes one planned deployment change.
type DeployComposePlanOperation struct {
	Action      string `json:"action"`
	Resource    string `json:"resource"`
	Name        string `json:"name,omitempty"`
	Service     string `json:"service,omitempty"`
	Machine     string `json:"machine,omitempty"`
	Image       string `json:"image,omitempty"`
	ContainerID string `json:"containerId,omitempty"`
	Order       string `json:"order,omitempty"`
}

// MachineResponse is the JSON representation of a cluster machine.
type MachineResponse struct {
	ID            string                  `json:"id"`
	Name          string                  `json:"name"`
	State         string                  `json:"state"`
	Network       *MachineNetworkResponse `json:"network,omitempty"`
	PublicIP      string                  `json:"publicIp,omitempty"`
	DaemonVersion string                  `json:"daemonVersion,omitempty"`
	DockerVersion string                  `json:"dockerVersion,omitempty"`
	Hostname      string                  `json:"hostname,omitempty"`
	Arch          string                  `json:"arch,omitempty"`
	OSPrettyName  string                  `json:"osPrettyName,omitempty"`
	KernelVersion string                  `json:"kernelVersion,omitempty"`
}

// MachineNetworkResponse is the JSON representation of a machine's cluster network.
type MachineNetworkResponse struct {
	Subnet       string   `json:"subnet,omitempty"`
	ManagementIP string   `json:"managementIp,omitempty"`
	Endpoints    []string `json:"endpoints"`
	PublicKey    string   `json:"publicKey,omitempty" format:"byte"`
}

// ServiceResponse is the JSON representation of a service and its containers.
type ServiceResponse struct {
	ID             string                     `json:"id"`
	Name           string                     `json:"name"`
	Mode           string                     `json:"mode"`
	Containers     []ServiceContainerResponse `json:"containers"`
	HookContainers []ServiceContainerResponse `json:"hookContainers"`
}

// ServiceContainerResponse identifies the machine that hosts a service container.
// The embedded Uncloud container model remains strongly typed and preserves the
// complete Docker inspection response for the web UI.
type ServiceContainerResponse struct {
	MachineID   string               `json:"machineId"`
	MachineName string               `json:"machineName"`
	Container   api.ServiceContainer `json:"container"`
}

// VolumeResponse identifies the machine that owns a Docker volume.
type VolumeResponse struct {
	MachineID   string        `json:"machineId"`
	MachineName string        `json:"machineName"`
	Volume      volume.Volume `json:"volume"`
}

// MachineMetadataResponse identifies the machine that produced an image listing.
type MachineMetadataResponse struct {
	MachineID   string `json:"machineId,omitempty"`
	MachineName string `json:"machineName,omitempty"`
	MachineAddr string `json:"machineAddr,omitempty"`
	Error       string `json:"error,omitempty"`
}

// ImageGroupResponse contains images reported by one machine.
type ImageGroupResponse struct {
	Metadata        *MachineMetadataResponse `json:"metadata,omitempty"`
	Images          []image.Summary          `json:"images"`
	ContainerdStore bool                     `json:"containerdStore"`
}

// MachineImageResponse is one image inspection result from a machine.
type MachineImageResponse struct {
	Metadata *MachineMetadataResponse `json:"metadata,omitempty"`
	Image    image.InspectResponse    `json:"image"`
}

// MachineInfoResponse is the small response used by the machine rename endpoint.
type MachineInfoResponse struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// LogMetadataResponse identifies the source of a streamed log entry.
type LogMetadataResponse struct {
	ServiceID   string `json:"serviceId,omitempty"`
	ServiceName string `json:"serviceName,omitempty"`
	ContainerID string `json:"containerId,omitempty"`
	MachineID   string `json:"machineId,omitempty"`
	MachineName string `json:"machineName,omitempty"`
	Hook        string `json:"hook,omitempty"`
}

// LogEventResponse is serialized as an SSE data payload.
type LogEventResponse struct {
	Metadata  *LogMetadataResponse `json:"metadata,omitempty"`
	Stream    string               `json:"stream" enum:"stdout,stderr,heartbeat,unknown"`
	Timestamp time.Time            `json:"timestamp"`
	Message   string               `json:"message,omitempty"`
	Error     string               `json:"error,omitempty"`
}

func machineResponse(native api.MachineMember) MachineResponse {
	response := MachineResponse{
		ID:            native.ID,
		Name:          native.Name,
		State:         native.State,
		DaemonVersion: native.DaemonVersion,
		DockerVersion: native.DockerVersion,
		Hostname:      native.Hostname,
		Arch:          native.Arch,
		OSPrettyName:  native.OSPrettyName,
		KernelVersion: native.KernelVersion,
	}
	if native.PublicIP.IsValid() {
		response.PublicIP = native.PublicIP.String()
	}
	if native.Network.Subnet.IsValid() || native.Network.ManagementIP.IsValid() ||
		len(native.Network.Endpoints) > 0 || len(native.Network.PublicKey) > 0 {
		network := &MachineNetworkResponse{
			Endpoints: make([]string, 0, len(native.Network.Endpoints)),
		}
		if native.Network.Subnet.IsValid() {
			network.Subnet = native.Network.Subnet.String()
		}
		if native.Network.ManagementIP.IsValid() {
			network.ManagementIP = native.Network.ManagementIP.String()
		}
		for _, endpoint := range native.Network.Endpoints {
			network.Endpoints = append(network.Endpoints, endpoint.String())
		}
		if len(native.Network.PublicKey) > 0 {
			network.PublicKey = base64.StdEncoding.EncodeToString(native.Network.PublicKey)
		}
		response.Network = network
	}

	return response
}

func serviceResponse(service api.Service) ServiceResponse {
	response := ServiceResponse{
		ID:             service.ID,
		Name:           service.Name,
		Mode:           service.Mode,
		Containers:     make([]ServiceContainerResponse, 0, len(service.Containers)),
		HookContainers: make([]ServiceContainerResponse, 0, len(service.HookContainers)),
	}
	for _, container := range service.Containers {
		response.Containers = append(response.Containers, ServiceContainerResponse{
			MachineID:   container.MachineID,
			MachineName: container.MachineName,
			Container:   container.Container,
		})
	}
	for _, container := range service.HookContainers {
		response.HookContainers = append(response.HookContainers, ServiceContainerResponse{
			MachineID:   container.MachineID,
			MachineName: container.MachineName,
			Container:   container.Container,
		})
	}
	return response
}

func volumeResponse(machineVolume api.MachineVolume) VolumeResponse {
	return VolumeResponse{
		MachineID:   machineVolume.MachineID,
		MachineName: machineVolume.MachineName,
		Volume:      machineVolume.Volume,
	}
}

func imageGroupResponse(machineImages api.MachineImages) ImageGroupResponse {
	images := machineImages.Images
	if images == nil {
		images = make([]image.Summary, 0)
	}
	response := ImageGroupResponse{
		Images:          images,
		ContainerdStore: machineImages.ContainerdStore,
	}
	if meta := machineImages.Metadata; meta != nil {
		response.Metadata = &MachineMetadataResponse{
			MachineID:   meta.MachineId,
			MachineName: meta.MachineName,
			MachineAddr: meta.MachineAddr,
			Error:       meta.Error,
		}
	}
	return response
}

func machineImageResponse(machineImage api.MachineImage) MachineImageResponse {
	response := MachineImageResponse{Image: machineImage.Image}
	if meta := machineImage.Metadata; meta != nil {
		response.Metadata = &MachineMetadataResponse{
			MachineID:   meta.MachineId,
			MachineName: meta.MachineName,
			MachineAddr: meta.MachineAddr,
			Error:       meta.Error,
		}
	}
	return response
}

// caddyCertificateResponse describes the leaf of a stored certificate chain.
// IssuedCertificateFromProto guarantees the chain is not empty.
func caddyCertificateResponse(cert api.IssuedCertificate) CaddyCertificateResponse {
	leaf := cert.Chain[0]
	fingerprint := cert.Fingerprint()
	response := CaddyCertificateResponse{
		SAN:          cert.SAN,
		DNSNames:     leaf.DNSNames,
		Issuer:       leaf.Issuer.CommonName,
		SerialNumber: leaf.SerialNumber.Text(16),
		NotBefore:    leaf.NotBefore,
		NotAfter:     leaf.NotAfter,
		SHA256:       hex.EncodeToString(fingerprint[:]),
	}
	if len(leaf.Issuer.Organization) > 0 {
		response.IssuerOrganization = leaf.Issuer.Organization[0]
	}
	if response.DNSNames == nil {
		response.DNSNames = []string{}
	}
	if acme := cert.IssuerData.ACME; acme != nil {
		response.ACME = &CaddyCertificateACMEResponse{CA: acme.CA, URL: acme.URL}
		if acme.RenewalInfo != nil {
			response.ACME.RenewalWindowStart = acme.RenewalInfo.SuggestedWindow.Start
			response.ACME.RenewalWindowEnd = acme.RenewalInfo.SuggestedWindow.End
		}
	}
	return response
}
