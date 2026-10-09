/**
 * Convenience aliases for the generated Uncloud schema components.
 *
 * Import these instead of reaching into `generated/schema` directly, so the
 * generated file stays an implementation detail that can be regenerated freely.
 */
import type { components } from "./generated/schema";

export type Schemas = components["schemas"];

// Cluster
export type CaddyConfig = Schemas["CaddyConfigResponse"];

export type CaddyConfigs = Schemas["CaddyConfigsResponse"];

export type ClusterDiagnostics = Schemas["ClusterDiagnosticsResponse"];

export type ClusterLink = Schemas["ClusterLinkResponse"];

export type DiagnosticMachine = Schemas["DiagnosticMachineResponse"];

export type DomainResponse = Schemas["DomainResponse"];

export type WireGuard = Schemas["WireGuardResponse"];

export type WireGuardPeer = Schemas["WireGuardPeerResponse"];

// Machines
export type Machine = Schemas["MachineResponse"];

export type MachineNetwork = Schemas["MachineNetworkResponse"];

export type MachineInfoResponse = Schemas["MachineInfoResponse"];

export type MachineExecRequest = Schemas["MachineExecRequest"];

export type MachineExecResponse = Schemas["MachineExecResponse"];

export type RenameMachineRequest = Schemas["RenameMachineRequest"];

// Services
export type Service = Schemas["ServiceResponse"];

export type ServiceContainer = Schemas["ServiceContainerResponse"];

export type RunServiceResponse = Schemas["RunServiceResponse"];

export type ContainerActionRequest = Schemas["ContainerActionRequest"];

export type ExecContainerRequest = Schemas["ExecContainerRequest"];

export type ExecContainerResponse = Schemas["ExecContainerResponse"];

export type DeployComposeRequest = Schemas["DeployComposeRequest"];

export type DeployComposeOptions = Schemas["DeployComposeOptions"];

export type DeployComposePlanOperation = Schemas["DeployComposePlanOperation"];

// Volumes
export type Volume = Schemas["VolumeResponse"];

export type VolumeAttachment = Schemas["VolumeAttachmentResponse"];

export type CreateVolumeRequest = Schemas["CreateVolumeRequest"];

// Images
export type ImageGroup = Schemas["ImageGroupResponse"];

export type ImageUpdate = Schemas["ImageUpdateResponse"];

export type MachineImage = Schemas["MachineImageResponse"];

export type RemoteImage = Schemas["RemoteImageResponse"];

// Shared
export type ErrorResponse = Schemas["ErrorResponse"];

export type StatusResponse = Schemas["StatusResponse"];

export type ReadinessResponse = Schemas["ReadinessResponse"];

// Server-Sent Event payloads
export type LogEvent = Schemas["LogEventResponse"];

export type LogMetadata = Schemas["LogMetadataResponse"];

export type MachineExecEvent = Schemas["MachineExecEvent"];

export type DeployComposeEvent = Schemas["DeployComposeEvent"];
