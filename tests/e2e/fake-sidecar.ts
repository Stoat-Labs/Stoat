import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type {
    ClusterDiagnostics,
    DeployComposeEvent,
    DomainResponse,
    ErrorResponse,
    LogEvent,
    Machine,
    Service,
    StatusResponse,
} from "@stoat/uncloud";
import * as v from "valibot";
import { parse } from "yaml";

export const SIDECAR_DOMAIN = "apps.e2e.test";

export const MACHINE: Machine = { id: "e2e-machine-1", name: "e2e-1", state: "Up" };

/** Images that make a deploy fail or never finish, so specs can drive those paths. */
export const FAILING_IMAGE = "e2e/fail";

export const HANGING_IMAGE = "e2e/hang";

/** Log lines every service streams before it starts sending heartbeats. */
export const LOG_LINES = ["listening on :3000", "GET /health 200", "worker ready"];

const composeSchema = v.object({
    services: v.record(
        v.string(),
        v.object({
            image: v.optional(v.string()),
            environment: v.optional(
                v.union([
                    v.array(v.string()),
                    v.record(v.string(), v.nullable(v.union([v.string(), v.number()]))),
                ]),
            ),
        }),
    ),
});

function environmentList(
    environment: v.InferOutput<typeof composeSchema>["services"][string]["environment"],
) {
    if (!environment) return [];

    if (Array.isArray(environment)) return environment;

    return Object.entries(environment).map(([key, value]) => `${key}=${value ?? ""}`);
}

/** A running service as `docker inspect` would describe its one container. */
function runningService(name: string, image: string, env: string[]): Service {
    const startedAt = new Date().toISOString();

    return {
        id: `svc-${name}`,
        name,
        mode: "replicated",
        hookContainers: [],
        containers: [
            {
                machineId: MACHINE.id,
                machineName: MACHINE.name,
                container: {
                    Id: `ctr-${name}`,
                    Name: `/${name}-e2e`,
                    Created: startedAt,
                    State: {
                        Status: "running",
                        Running: true,
                        StartedAt: startedAt,
                        Health: { Status: "healthy" },
                    },
                    Config: { Image: image, Env: env, Labels: { "uncloud.service.name": name } },
                },
            },
        ],
    };
}

function sendEvent(response: ServerResponse, event: DeployComposeEvent | LogEvent) {
    response.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Everything the fake answers with as JSON. */
type Reply =
    | string[]
    | ClusterDiagnostics
    | DomainResponse
    | ErrorResponse
    | StatusResponse
    | Service
    | { items: Machine[] | Service[] }
    | { exitCode: number; truncated: boolean; stdout: string };

function json(response: ServerResponse, status: number, body: Reply) {
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(body));
}

/**
 * What GreptimeDB (reached through `curl` inside its container) answers. Initialization only
 * needs to see this machine reporting metrics and at least one log line; every other query
 * finds no data, so monitoring pages show their empty states.
 */
function monitoringAnswer(command: string[]) {
    const url = command.at(-1) ?? "";
    const query = command.find((arg) => arg.startsWith("sql="))?.slice("sql=".length) ?? "";

    if (url.includes("/prometheus/"))
        return { status: "success", data: { resultType: "matrix", result: [] } };

    const rows = query.includes("node_uname_info")
        ? [[MACHINE.id]]
        : query.includes("COUNT(*)") && query.includes("docker_logs")
          ? [[1]]
          : [];

    return { code: 0, output: [{ records: { rows } }] };
}

const execSchema = v.object({ command: v.array(v.string()) });

/**
 * Just enough of the Uncloud sidecar for the app: cluster info, machines, a deploy stream
 * that records services, service lookups, and log streams. Unknown routes get a fast 404 so
 * nothing in the app hangs. `/__received` and `/__reset` let specs (in other processes)
 * inspect and clear what was deployed.
 */
export async function startFakeSidecar() {
    let received: string[] = [];
    const services = new Map<string, Service>();

    /** Deploys the compose file, or only the `only` services of it when given. */
    function deploy(compose: string, only: string[] | undefined, response: ServerResponse) {
        received.push(compose);
        const parsed = v.parse(composeSchema, parse(compose));

        const entries = Object.entries(parsed.services).filter(
            ([name]) => !only?.length || only.includes(name),
        );

        response.writeHead(200, { "Content-Type": "text/event-stream" });
        sendEvent(response, {
            type: "plan",
            operations: entries.map(([name, service]) => ({
                action: "create",
                resource: "container",
                service: name,
                image: service.image,
            })),
        });

        if (entries.some(([, service]) => service.image === HANGING_IMAGE)) {
            // Held open until the worker cancels the deploy and drops the connection.
            sendEvent(response, {
                type: "progress",
                id: "pull",
                phase: "working",
                text: "Pulling",
            });

            return;
        }

        if (entries.some(([, service]) => service.image === FAILING_IMAGE)) {
            sendEvent(response, { type: "error", error: `Unable to pull image ${FAILING_IMAGE}` });
            response.end();

            return;
        }

        for (const [name, service] of entries) {
            const image = service.image ?? "unknown";
            services.set(name, runningService(name, image, environmentList(service.environment)));
            sendEvent(response, {
                type: "progress",
                id: name,
                phase: "done",
                text: `Started ${name}`,
            });
        }

        sendEvent(response, { type: "complete", status: "Deployment complete." });
        response.end();
    }

    function streamLogs(serviceName: string, follow: boolean, response: ServerResponse) {
        response.writeHead(200, { "Content-Type": "text/event-stream" });

        for (const message of LOG_LINES)
            sendEvent(response, {
                stream: "stdout",
                timestamp: new Date().toISOString(),
                message,
                metadata: {
                    serviceName,
                    serviceId: `svc-${serviceName}`,
                    machineId: MACHINE.id,
                    machineName: MACHINE.name,
                    containerId: `ctr-${serviceName}`,
                },
            });

        if (!follow) {
            response.end();

            return;
        }

        const heartbeat = setInterval(
            () => sendEvent(response, { stream: "heartbeat", timestamp: new Date().toISOString() }),
            1_000,
        );

        response.on("close", () => clearInterval(heartbeat));
    }

    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];

        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const url = new URL(request.url ?? "/", "http://sidecar");
        const path = url.pathname;
        const get = request.method === "GET";

        if (path === "/__received") return json(response, 200, received);

        if (path === "/__reset") {
            received = [];
            services.clear();

            return json(response, 200, received);
        }

        if (get && path === "/api/v1/cluster/domain")
            return json(response, 200, { domain: SIDECAR_DOMAIN, reserved: true });

        if (get && path === "/api/v1/cluster/diagnostics") {
            const diagnostics: ClusterDiagnostics = {
                status: "healthy",
                issues: [],
                machines: [MACHINE],
                links: [],
                versionDrift: false,
            };

            return json(response, 200, diagnostics);
        }

        if (get && path === "/api/v1/machines") return json(response, 200, { items: [MACHINE] });

        if (get && path === "/api/v1/services")
            return json(response, 200, { items: [...services.values()] });

        if (request.method === "POST" && path === "/api/v1/services/deploy/compose") {
            const body = v.parse(
                v.object({
                    compose: v.string(),
                    options: v.optional(v.object({ services: v.optional(v.array(v.string())) })),
                }),
                JSON.parse(Buffer.concat(chunks).toString()),
            );

            return deploy(
                Buffer.from(body.compose, "base64").toString(),
                body.options?.services,
                response,
            );
        }

        if (
            request.method === "POST" &&
            /^\/api\/v1\/services\/[^/]+\/containers\/[^/]+\/exec$/u.test(path)
        ) {
            const { command } = v.parse(execSchema, JSON.parse(Buffer.concat(chunks).toString()));

            return json(response, 200, {
                exitCode: 0,
                truncated: false,
                stdout: JSON.stringify(monitoringAnswer(command)),
            });
        }

        const logs = /^\/api\/v1\/services\/([^/]+)\/logs$/u.exec(path);

        if (get && logs) {
            const service = services.get(decodeURIComponent(logs[1]!).replace(/^svc-/u, ""));

            if (!service) return json(response, 404, { error: "service not found" });

            return streamLogs(service.name, url.searchParams.get("follow") === "true", response);
        }

        const lookup = /^\/api\/v1\/services\/([^/]+)$/u.exec(path);

        if (get && lookup) {
            const id = decodeURIComponent(lookup[1]!);
            const service = services.get(id) ?? services.get(id.replace(/^svc-/u, ""));

            return service
                ? json(response, 200, service)
                : json(response, 404, { error: "service not found" });
        }

        if (request.method === "DELETE" && lookup) {
            const id = decodeURIComponent(lookup[1]!);

            return services.delete(id)
                ? json(response, 200, { status: "removed" })
                : json(response, 404, { error: "service not found" });
        }

        json(response, 404, { error: `fake sidecar: no route for ${request.method} ${path}` });
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    // SAFETY: listen(0, "127.0.0.1") creates a TCP server, never a Unix socket.
    const { port } = server.address() as AddressInfo;

    return {
        url: `http://127.0.0.1:${port}`,
        stop: () =>
            new Promise<void>((done) => {
                server.closeAllConnections();
                server.close(() => done());
            }),
    };
}
