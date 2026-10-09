import createClient from "openapi-fetch";

import { UcApiError } from "./errors";
import type { paths } from "./generated/schema";
import { readSseJson } from "./sse";
import type {
    DeployComposeEvent,
    DeployComposeOptions,
    LogEvent,
    MachineExecEvent,
    MachineExecRequest,
} from "./types";

export { UcApiError, unwrap } from "./errors";

export { readSseJson, readSseMessages, type SseMessage } from "./sse";

export type * from "./types";

export type { paths } from "./generated/schema";

export type UcClientOptions = {
    /**
     * Bearer token for the sidecar.
     *
     * Required in practice: the sidecar rejects every endpoint except
     * `/healthz` with a 401 without it. It is optional here only so a
     * health-probe client can be built without a credential.
     */
    token?: string;
    /** Custom fetch, mainly for tests. Defaults to `globalThis.fetch`. */
    fetch?: typeof globalThis.fetch;
    /** Headers sent with every request. */
    headers?: Record<string, string>;
};

/** Shared options for the Server-Sent Event helpers. */
export type StreamOptions = {
    /** Abort the request and end the iterator. Always pass one for followed logs. */
    signal?: AbortSignal;
};

export type ServiceLogsOptions = StreamOptions &
    NonNullable<paths["/api/v1/services/{id}/logs"]["get"]["parameters"]["query"]>;

export type MachineLogsOptions = StreamOptions &
    paths["/api/v1/machines/{id}/logs"]["get"]["parameters"]["query"];

/** The result of a request made with `parseAs: "stream"`. */
type StreamResult = {
    data?: ReadableStream<Uint8Array> | null;
    error?: unknown;
    response: Response;
};

/** Event streams ask for this explicitly, so a proxy cannot answer with a cached page. */
const sseHeaders = { Accept: "text/event-stream" };

/**
 * Turns an event stream response into typed events, throwing `UcApiError` when
 * the sidecar refused to open the stream.
 */
async function* readEvents<T>(request: Promise<StreamResult>): AsyncGenerator<T, void, undefined> {
    const { data, error, response } = await request;

    if (!response.ok) {
        throw new UcApiError(response, error);
    }

    if (!data) {
        throw new UcApiError(response, { error: "Sidecar returned an empty stream" });
    }

    yield* readSseJson<T>(data);
}

/**
 * Validates a sidecar URL and strips any trailing slash.
 *
 * Worth doing eagerly: the URL now arrives at runtime (from a cluster record,
 * config, or an operator) rather than being checked once at boot, so a bad value
 * would otherwise surface as a confusing fetch failure much later. Restricting
 * the protocol also stops a stored value from reaching `file:` or similar.
 */
function normalizeSidecarUrl(sidecarUrl: string): string {
    const trimmed = sidecarUrl.trim();

    if (trimmed === "") {
        throw new TypeError("Sidecar URL is empty.");
    }

    let parsed: URL;

    try {
        parsed = new URL(trimmed);
    } catch {
        throw new TypeError(
            `Invalid sidecar URL: ${JSON.stringify(sidecarUrl)}. Expected an absolute URL such as "http://sidecar.internal".`,
        );
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new TypeError(
            `Unsupported sidecar URL protocol ${JSON.stringify(parsed.protocol)}. Expected "http:" or "https:".`,
        );
    }

    return trimmed.replace(/\/+$/, "");
}

/**
 * Creates a typed client for a specific Uncloud sidecar.
 *
 * The sidecar URL is a parameter rather than ambient configuration, so one
 * process can talk to many clusters — pass whichever URL belongs to the cluster
 * you are acting on.
 *
 * Server-side only. The bearer token is a root-equivalent credential — the
 * sidecar exposes arbitrary command execution on cluster hosts (`execMachine`,
 * `execContainer`) and has no users, roles, or scopes, so anyone holding the
 * token can do everything. Never construct this in browser code, never ship the
 * token to a client, and never expose it through an unauthenticated route.
 *
 * The returned object is an `openapi-fetch` client (`GET`/`POST`/`PATCH`/`DELETE`,
 * each returning `{ data, error, response }`) plus a `stream` namespace for the
 * four `text/event-stream` endpoints.
 *
 * Construction is cheap — it allocates a closure and does no I/O — so calling it
 * per request is fine and avoids stale URLs.
 *
 * ```ts
 * const uc = ucClient("http://sidecar.internal", { token: env.SIDECAR_TOKEN });
 *
 * const { data, error } = await uc.GET("/api/v1/machines", {
 *     params: { query: { available: true } },
 * });
 *
 * for await (const event of uc.stream.serviceLogs("web", { follow: true, tail: 100 })) {
 *     console.log(event.message);
 * }
 * ```
 *
 * @param sidecarUrl Base URL of the sidecar, e.g. `http://sidecar.internal`.
 *   A trailing slash is fine. Must be `http:` or `https:`.
 * @throws {TypeError} If the URL is unparseable or uses an unsupported protocol.
 */
export function ucClient(sidecarUrl: string, options: UcClientOptions = {}) {
    const baseUrl = normalizeSidecarUrl(sidecarUrl);

    // The token is merged into the default headers rather than passed per call,
    // so no call site can forget it. An explicit Authorization header in
    // `options.headers` still wins.
    const headers = new Headers(options.headers);

    if (options.token && !headers.has("authorization")) {
        headers.set("authorization", `Bearer ${options.token}`);
    }

    const client = createClient<paths>({
        baseUrl,
        headers,
        // Resolve the global fetch per request rather than once here, so a fetch
        // replaced later (instrumentation, test stubs) also reaches long-lived clients.
        fetch: options.fetch ?? ((request) => globalThis.fetch(request)),
    });

    return {
        ...client,

        /** Base URL this client targets, useful for logging. */
        baseUrl,

        stream: {
            /**
             * Streams logs for a service. Set `follow: true` to tail; pass a `signal`
             * to stop, otherwise the request stays open indefinitely.
             */
            serviceLogs(id: string, options: ServiceLogsOptions = {}) {
                const { signal, ...query } = options;

                return readEvents<LogEvent>(
                    client.GET("/api/v1/services/{id}/logs", {
                        params: { path: { id }, query },
                        headers: sseHeaders,
                        parseAs: "stream",
                        signal,
                    }),
                );
            },

            /** Streams logs for a system service (`uncloud`, `docker`, ...) on a machine. */
            machineLogs(id: string, options: MachineLogsOptions) {
                const { signal, ...query } = options;

                return readEvents<LogEvent>(
                    client.GET("/api/v1/machines/{id}/logs", {
                        params: { path: { id }, query },
                        headers: sseHeaders,
                        parseAs: "stream",
                        signal,
                    }),
                );
            },

            /**
             * Runs a command on a machine host, streaming stdout/stderr as it arrives.
             *
             * This executes on the host, not in a container. Never build the command
             * from unvalidated input.
             */
            machineExec(id: string, body: MachineExecRequest, options: StreamOptions = {}) {
                return readEvents<MachineExecEvent>(
                    client.POST("/api/v1/machines/{id}/exec/stream", {
                        params: { path: { id } },
                        body,
                        headers: sseHeaders,
                        parseAs: "stream",
                        signal: options.signal,
                    }),
                );
            },

            /**
             * Deploys a Compose file, streaming plan and progress events.
             *
             * `compose` must be the base64-encoded file contents; use
             * `encodeComposeFile()` rather than encoding by hand.
             */
            deployCompose(
                compose: string,
                deployOptions?: DeployComposeOptions,
                options: StreamOptions = {},
            ) {
                return readEvents<DeployComposeEvent>(
                    client.POST("/api/v1/services/deploy/compose", {
                        body: { compose, options: deployOptions },
                        headers: sseHeaders,
                        parseAs: "stream",
                        signal: options.signal,
                    }),
                );
            },
        },
    };
}

export type UcClient = ReturnType<typeof ucClient>;

/**
 * Base64-encodes Compose file contents for `stream.deployCompose()`.
 *
 * The spec types `compose` as `format: byte`, which the sidecar expects as
 * base64. Encoding via UTF-8 bytes keeps non-ASCII values correct.
 */
export function encodeComposeFile(contents: string): string {
    return Buffer.from(contents, "utf8").toString("base64");
}
