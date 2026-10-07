export type DeploymentVariant = "success" | "warning" | "error" | "secondary";

export function deploymentStatusLabel(status: string, retrying = false) {
    if (retrying) return "Retrying";

    switch (status) {
        case "queued":
            return "Queued";
        case "running":
            return "Running";
        case "ready":
            return "Ready";
        case "failed":
            return "Failed";
        case "cancelled":
            return "Cancelled";
        default:
            return status;
    }
}

export function deploymentStatusVariant(status: string): DeploymentVariant {
    if (status === "ready") return "success";

    if (status === "failed") return "error";

    if (status === "queued" || status === "running") return "warning";

    return "secondary";
}

export function isActiveDeploymentStatus(status: string) {
    return status === "queued" || status === "running";
}

export function isTerminalDeploymentStatus(status: string) {
    return status === "ready" || status === "failed" || status === "cancelled";
}
