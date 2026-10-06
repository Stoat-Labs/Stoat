import type { DeploymentLine, DeploymentStep } from "$lib/deployment-steps";

/** A scripted log line; `at` is seconds since the deployment started. */
export type ScriptLine = Omit<DeploymentLine, "time"> & { at: number };

export type Scenario = {
    label: string;
    /** Deployment status the viewer would see once every line has arrived. */
    status: "queued" | "running" | "ready" | "failed" | "cancelled";
    error: string | null;
    seconds: number;
    lines: ScriptLine[];
};

const line = (
    at: number,
    message: string,
    event?: string,
    level: DeploymentLine["level"] = "other",
): ScriptLine => ({ at, message, event, level });

const progress = (at: number, message: string, level: DeploymentLine["level"] = "other") =>
    line(at, message, "progress", level);

const layer = (image: string, machine: string, id: string, percent: number, total: number) =>
    `Image ${image} on ${machine} | ${id} on ${machine} | Downloading | [=>] ${Math.round((total * percent) / 100e6)}MB/${total / 1e6}MB (${percent}%) [${Math.round((total * percent) / 100)}/${total}]`;

/** Image pull for one image on one machine, ending with "Pulled" unless `stopAt` is given. */
function pull(
    at: number,
    image: string,
    machine: string,
    layers: [id: string, steps: number[], total: number][],
    finish = true,
) {
    const lines = [
        progress(at, `Container x on ${machine} | Image ${image} on ${machine} | Pulling`),
    ];

    let t = at;

    for (const [id, steps, total] of layers) {
        for (const percent of steps) {
            t += 0.8;
            lines.push(progress(t, layer(image, machine, id, percent, total)));
        }

        if (finish || steps.at(-1) === 100)
            lines.push(
                progress(
                    t + 0.2,
                    `Image ${image} on ${machine} | ${id} on ${machine} | Pull complete`,
                ),
            );
    }

    if (finish)
        lines.push(
            progress(t + 0.5, `Container x on ${machine} | Image ${image} on ${machine} | Pulled`),
        );

    return lines;
}

function container(at: number, name: string, machine: string, states: [number, string][]) {
    return states.map(([offset, state]) =>
        progress(at + offset, `Container ${name} on ${machine} | ${state}`),
    );
}

const queued = line(0, "Resource deployment queued. Saved Compose snapshot captured.");

const plan = (...ops: string[]) => [
    line(0.8, `Deployment plan: ${ops.length} operation(s).`, "plan"),
    ...ops.map((op) => line(0.8, op, "plan")),
];

const web = "ghcr.io/acme/web:2.4.0";

const retire = (at: number) =>
    container(at, "web/2e24373f93bf", "luna", [
        [0, "Removing"],
        [0.4, "Removed"],
    ]);

const ready: Scenario = {
    label: "Ready",
    status: "ready",
    error: null,
    seconds: 41.6,
    lines: [
        queued,
        ...plan(
            "create volume showcase-data luna",
            "replace container web ghcr.io/acme/web:2.4.0 2e24373f93bf luna stop-first",
            "create container worker ghcr.io/acme/worker:2.1.0 - hazel",
            "replace container cache redis:7-alpine 91c0d3a77b2e hazel start-first",
        ),
        progress(1, "Volume showcase-data on luna | Creating"),
        progress(1.3, "Volume showcase-data on luna | Created"),
        ...pull(1.5, web, "luna", [
            ["a1b2c3d4e5f6", [20, 55, 100], 48e6],
            ["b2c3d4e5f6a1", [40, 100], 12e6],
        ]),
        ...pull(2, "redis:7-alpine", "hazel", [["c3d4e5f6a1b2", [50, 100], 3e6]]),
        ...container(8, "migrate", "luna", [
            [0, "Creating"],
            [0.4, "Started"],
            [0.5, "Running"],
            [3, "Removed"],
        ]).map((entry) => ({
            ...entry,
            message: entry.message.replace("Container migrate", "Pre-deploy hook migrate"),
        })),
        ...container(11.2, "web/2e24373f93bf", "luna", [
            [0, "Stopping"],
            [0.6, "Stopped"],
        ]),
        ...container(12, "web-7vtu", "luna", [
            [0, "Creating"],
            [0.3, "Created"],
            [0.5, "Starting"],
            [1, "Started"],
            [1.1, "Monitoring (5s)"],
            [6.2, "Health checking"],
            [7, "Healthy"],
        ]),
        ...retire(19.2),
        ...container(20, "worker-k3p9", "hazel", [
            [0, "Creating"],
            [0.4, "Created"],
            [0.6, "Starting"],
            [1.1, "Started"],
            [1.2, "Monitoring (5s)"],
            [6.3, "Running"],
        ]),
        ...container(25, "cache-q8wz", "hazel", [
            [0, "Starting"],
            [0.5, "Started"],
            [0.6, "Monitoring (60s)"],
            [5, "Health checking"],
            [6, "Healthy"],
        ]),
        line(36, "Waiting for ingress to pick up the new routes (attempt 1/5)…", "step"),
        line(38, "Waiting for ingress to pick up the new routes (attempt 2/5)…", "step"),
        line(40, "Waiting for ingress to pick up the new routes (attempt 3/5)…", "step"),
        line(
            41,
            "Ingress routes verified · https://showcase.example.com is serving traffic",
            "step",
        ),
        line(41.5, "deployed", "complete"),
        line(41.6, "Resource deployment is ready.", "ready"),
    ],
};

const unhealthy = (at: number, name: string) => [
    ...container(at, name, "luna", [
        [0, "Creating"],
        [0.3, "Created"],
        [0.5, "Starting"],
        [0.9, "Started"],
        [1, "Monitoring (5s)"],
    ]),
    progress(at + 6.1, `Container ${name} on luna | Unhealthy (Exited (1))`, "error"),
    line(
        at + 6.2,
        `new container '${name}' failed to become healthy: container is unhealthy after monitor period (5s): Exited (1). It's stopped and available for inspection. View logs with 'uc logs ${name}'`,
        "error",
        "error",
    ),
];

const failed: Scenario = {
    label: "Failed",
    status: "failed",
    error: "Deployment failed after 3 attempts.",
    seconds: 52,
    lines: [
        queued,
        ...plan(
            "replace container api ghcr.io/acme/api:3.0.0 5d4c97aa10be luna start-first",
            "create container search ghcr.io/acme/search:missing - hazel",
        ),
        progress(
            1.5,
            "Container search-x on hazel | Image ghcr.io/acme/search:missing on hazel | pull access denied, repository does not exist or may require authorization",
            "error",
        ),
        ...pull(2, "ghcr.io/acme/api:3.0.0", "luna", [["d4e5f6a1b2c3", [30, 100], 30e6]]),
        ...unhealthy(4.5, "api-4fqz"),
        line(10.8, "Attempt 1 of 3 failed; retrying.", "retry", "error"),
        ...unhealthy(22, "api-a8xc"),
        line(28.3, "Attempt 2 of 3 failed; retrying.", "retry", "error"),
        line(52, "Deployment failed after 3 attempts.", "failed", "error"),
    ],
};

const cancelled: Scenario = {
    label: "Cancelled",
    status: "cancelled",
    error: "Cancelled by user.",
    seconds: 9,
    lines: [
        queued,
        ...plan(
            "create container web ghcr.io/acme/web:2.4.0 - luna",
            "create container big ghcr.io/acme/big:1.0 - hazel",
        ),
        ...pull(1, web, "luna", [["a1b2c3d4e5f6", [70, 100], 48e6]]),
        ...pull(1.2, "ghcr.io/acme/big:1.0", "hazel", [["e5f6a1b2c3d4", [30, 62], 500e6]], false),
        ...container(2.6, "web-m2kd", "luna", [
            [0, "Creating"],
            [0.3, "Created"],
            [0.4, "Starting"],
            [0.8, "Started"],
            [0.9, "Monitoring (5s)"],
        ]),
    ],
};

const retrying: Scenario = {
    label: "Retrying",
    status: "queued",
    error: "Attempt 1 of 5 failed; retrying",
    seconds: 14,
    lines: [
        queued,
        ...plan("replace container api ghcr.io/acme/api:3.0.0 5d4c97aa10be luna start-first"),
        ...unhealthy(2, "api-4fqz"),
        line(8.5, "Attempt 1 of 5 failed; retrying.", "retry", "error"),
    ],
};

/** Every state in motion: pulls and monitoring advance, the cursor blinks, then it settles. */
const live: Scenario = {
    label: "Live run",
    status: "ready",
    error: null,
    seconds: 34,
    lines: [
        queued,
        ...plan(
            "replace container web ghcr.io/acme/web:2.4.0 2e24373f93bf luna stop-first",
            "create container cache redis:7-alpine - hazel",
        ),
        ...pull(1.5, web, "luna", [
            ["a1b2c3d4e5f6", [10, 25, 40, 60, 80, 100], 96e6],
            ["b2c3d4e5f6a1", [30, 70, 100], 24e6],
        ]),
        ...pull(2, "redis:7-alpine", "hazel", [["c3d4e5f6a1b2", [50, 100], 6e6]]),
        ...container(11, "web/2e24373f93bf", "luna", [
            [0, "Stopping"],
            [0.7, "Stopped"],
        ]),
        ...container(12, "web-7vtu", "luna", [
            [0, "Creating"],
            [0.4, "Created"],
            [0.7, "Starting"],
            [1.2, "Started"],
            [1.3, "Monitoring (10s)"],
            [11.4, "Health checking"],
            [13, "Healthy"],
        ]),
        ...retire(25.2),
        ...container(14, "cache-q8wz", "hazel", [
            [0, "Creating"],
            [0.4, "Created"],
            [0.7, "Starting"],
            [1.2, "Started"],
            [1.3, "Monitoring (6s)"],
            [7.4, "Running"],
        ]),
        line(27, "Waiting for ingress to pick up the new routes (attempt 1/5)…", "step"),
        line(29, "Waiting for ingress to pick up the new routes (attempt 2/5)…", "step"),
        line(
            32,
            "Ingress routes verified · https://showcase.example.com is serving traffic",
            "step",
        ),
        line(33.5, "deployed", "complete"),
        line(34, "Resource deployment is ready.", "ready"),
    ],
};

export const scenarios = { live, ready, failed, cancelled, retrying } as const;

export type ScenarioKey = keyof typeof scenarios | "loading" | "empty";

export const scenarioKeys = [
    "live",
    "ready",
    "failed",
    "cancelled",
    "retrying",
    "loading",
    "empty",
] as const satisfies readonly ScenarioKey[];

export const scenarioLabels: Record<ScenarioKey, string> = {
    live: "Live run",
    ready: "Ready",
    failed: "Failed",
    cancelled: "Cancelled",
    retrying: "Retrying",
    loading: "Loading",
    empty: "Empty",
};

const base = (): Pick<DeploymentStep, "time" | "history" | "ops"> => ({
    time: 0,
    history: [],
    ops: [],
});

/** One handcrafted step per kind and state, for the legend. */
export const legend = (monitorSince: number): { title: string; steps: DeploymentStep[] }[] => [
    {
        title: "Notes",
        steps: [
            {
                ...base(),
                key: "n1",
                kind: "note",
                state: "active",
                title: "Waiting for GreptimeDB to become healthy",
            },
            {
                ...base(),
                key: "n2",
                kind: "note",
                state: "done",
                title: "GreptimeDB is healthy",
                detail: "Creating monitoring database",
            },
            {
                ...base(),
                key: "n3",
                kind: "note",
                state: "error",
                title: "Step failed: sidecar unreachable",
                detail: "Check the machine and retry",
            },
            {
                ...base(),
                key: "n4",
                kind: "note",
                state: "stopped",
                title: "Stopped before it finished",
            },
        ],
    },
    {
        title: "Plan",
        steps: [
            {
                ...base(),
                key: "p1",
                kind: "plan",
                state: "done",
                title: "Plan",
                ops: [
                    { title: "replace web", detail: "ghcr.io/acme/web:2.4.0 · luna · stop-first" },
                    { title: "create volume data", detail: "luna" },
                ],
            },
            { ...base(), key: "p2", kind: "plan", state: "done", title: "Plan" },
        ],
    },
    {
        title: "Image pulls",
        steps: [
            {
                ...base(),
                key: "i1",
                kind: "pull",
                state: "active",
                title: "ghcr.io/acme/web:2.4.0",
                machine: "luna",
                pull: { percent: 62, current: 29_760_000, total: 48_000_000 },
            },
            {
                ...base(),
                key: "i2",
                kind: "pull",
                state: "done",
                title: "redis:7-alpine",
                machine: "hazel",
                pull: { percent: 100, current: 3_000_000, total: 3_000_000 },
            },
            {
                ...base(),
                key: "i3",
                kind: "pull",
                state: "error",
                title: "ghcr.io/acme/missing:1",
                machine: "luna",
                detail: "pull access denied, repository does not exist",
            },
            {
                ...base(),
                key: "i4",
                kind: "pull",
                state: "stopped",
                title: "ghcr.io/acme/big:1.0",
                machine: "hazel",
                pull: { percent: 41, current: 205_000_000, total: 500_000_000 },
            },
        ],
    },
    {
        title: "Containers, volumes and hooks",
        steps: [
            {
                ...base(),
                key: "c1",
                kind: "resource",
                state: "active",
                title: "web-7vtu",
                machine: "luna",
                history: ["created", "starting"],
            },
            {
                ...base(),
                key: "c1b",
                kind: "resource",
                state: "active",
                title: "web-7vtu",
                machine: "luna",
                history: ["created", "started", "monitoring"],
                monitor: { since: monitorSince, seconds: 10 },
            },
            {
                ...base(),
                key: "c2",
                kind: "resource",
                state: "done",
                title: "web-7vtu",
                machine: "luna",
                history: ["created", "started", "healthy"],
            },
            {
                ...base(),
                key: "c3",
                kind: "resource",
                state: "error",
                title: "api-4fqz",
                machine: "luna",
                history: ["created", "started", "unhealthy"],
                detail: "Exited (1)",
            },
            {
                ...base(),
                key: "c4",
                kind: "resource",
                state: "stopped",
                title: "web-m2kd",
                machine: "luna",
                history: ["created", "starting"],
            },
            {
                ...base(),
                key: "c5",
                kind: "resource",
                state: "done",
                label: "Volume",
                title: "showcase-data",
                machine: "luna",
                history: ["created"],
            },
            {
                ...base(),
                key: "c6",
                kind: "resource",
                state: "done",
                label: "Pre-deploy hook",
                title: "migrate",
                machine: "luna",
                history: ["started", "running", "removed"],
            },
        ],
    },
];
