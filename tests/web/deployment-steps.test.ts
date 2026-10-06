import { expect, it } from "vite-plus/test";
import { deploymentSteps, type DeploymentLine } from "../../apps/web/src/lib/deployment-steps";

const lines = (entries: [number, string, string?, DeploymentLine["level"]?][]): DeploymentLine[] =>
    entries.map(([time, message, event, level = "other"]) => ({ time, message, event, level }));

const replace = lines([
    [0, "Resource deployment queued. Saved Compose snapshot captured."],
    [0, "Loading deployment input.", "step"],
    [0, "Formatting Compose snapshot.", "step"],
    [0, "Formatted 1 service(s).", "step"],
    [0, "Deploying Compose to the cluster.", "step"],
    [0, "Deployment plan: 1 operation(s).", "plan"],
    [
        0,
        "replace container trilium triliumnext/trilium:latest 2e24373f93bf luna stop-first",
        "plan",
    ],
    [0, "Container trilium/2e24373f93bf on luna | Stopping", "progress"],
    [0, "Container trilium/2e24373f93bf on luna | Stopped", "progress"],
    [0, "Container trilium-7vtu on luna | Creating", "progress"],
    [0, "Container trilium-7vtu on luna | Created", "progress"],
    [0, "Container trilium-7vtu on luna | Starting", "progress"],
    [1000, "Container trilium-7vtu on luna | Started", "progress"],
    [1000, "Container trilium-7vtu on luna | Monitoring (5s)", "progress"],
    [2000, "Container trilium-7vtu on luna | Monitoring (5s)", "progress"],
    [6000, "Container trilium-7vtu on luna | Health checking", "progress"],
    [7000, "Container trilium-7vtu on luna | Healthy", "progress"],
    [7000, "Container trilium/2e24373f93bf on luna | Removing", "progress"],
    [7000, "Container trilium/2e24373f93bf on luna | Removed", "progress"],
    [7000, "deployed", "complete"],
    [7000, "Resource deployment is ready.", "ready"],
]);

it("collapses a replace deployment into a short step list", () => {
    const steps = deploymentSteps(replace, false);

    expect(
        steps.map((step) => [step.kind, step.title, step.state, step.history.join(" → ")]),
    ).toEqual([
        ["note", "Resource deployment queued", "done", ""],
        ["plan", "Plan", "done", ""],
        ["resource", "trilium/2e2437", "done", "stopped → removed"],
        ["resource", "trilium-7vtu", "done", "created → started → healthy"],
    ]);
    expect(steps[0]?.detail).toBe("Saved Compose snapshot captured");
    expect(steps[1]?.ops).toEqual([
        {
            title: "replace trilium",
            detail: "triliumnext/trilium:latest · 2e2437 · luna · stop-first",
        },
    ]);
    expect(steps[3]?.machine).toBe("luna");
});

it("shows live monitoring as the active step", () => {
    const steps = deploymentSteps(replace.slice(0, 15), true);

    expect(steps.at(-1)).toMatchObject({
        state: "active",
        history: ["created", "started", "monitoring"],
        monitor: { since: 1000, seconds: 5 },
    });
});

it("aggregates image layers into one pull bar", () => {
    const image = "Container web-1 on luna | Image nginx:1 on luna";

    const steps = deploymentSteps(
        lines([
            [0, `${image} | Pulling`, "progress"],
            [
                1,
                `Image nginx:1 on luna | aaaaaaaaaaaa on luna | Downloading | [=>] 25MB/100MB (25%) [25/100]`,
                "progress",
            ],
            [2, `Image nginx:1 on luna | bbbbbbbbbbbb on luna | Already exists (100%)`, "progress"],
            [
                3,
                `Image nginx:1 on luna | bbbbbbbbbbbb on luna | Downloading | [=>] 0/100 [0/100]`,
                "progress",
            ],
        ]),
        true,
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
        kind: "pull",
        title: "nginx:1",
        state: "active",
        pull: { percent: 63, current: 125, total: 200 },
    });

    const done = deploymentSteps(
        lines([
            [0, `${image} | Pulling`, "progress"],
            [5, `${image} | Pulled`, "progress"],
        ]),
        false,
    );

    expect(done[0]).toMatchObject({ state: "done", pull: { percent: 100 } });
});

it("treats running as settled for containers without a health check", () => {
    const steps = deploymentSteps(
        lines([
            [0, "Container web-1 on luna | Monitoring (5s)", "progress"],
            [5, "Container web-1 on luna | Running", "progress"],
        ]),
        true,
    );

    expect(steps[0]).toMatchObject({ state: "done", history: ["running"] });
});

it("marks failures and keeps the reason", () => {
    const steps = deploymentSteps(
        lines([
            [0, "Container web-1 on luna | Monitoring (5s)", "progress"],
            [5, "Container web-1 on luna | Unhealthy (Exited (1))", "progress", "error"],
            [5, "container is unhealthy after monitor period (5s): Exited (1)", "error", "error"],
        ]),
        false,
    );

    expect(steps.map((step) => [step.state, step.detail ?? step.title])).toEqual([
        ["error", "Exited (1)"],
        ["error", "container is unhealthy after monitor period (5s): Exited (1)"],
    ]);
});

it("collapses repeated status notes and marks the latest one active", () => {
    const steps = deploymentSteps(
        lines([
            [0, "Verifying metrics and log ingestion…", "step"],
            [1, "Still verifying ingestion (attempt 2/40)…", "step"],
            [2, "Still verifying ingestion (attempt 3/40)…", "step"],
        ]),
        true,
    );

    expect(steps.map((step) => [step.title, step.state])).toEqual([
        ["Verifying metrics and log ingestion", "done"],
        ["Still verifying ingestion (attempt 3/40)", "active"],
    ]);
});

it("groups logs stored without event tags", () => {
    const steps = deploymentSteps(
        lines([
            [0, "Deploying Alloy collectors…"],
            [1, "Deployment plan: 2 operation(s)."],
            [1, "replace container alloy grafana/alloy:v1 691d7b257a41 hazel stop-first"],
            [1, "replace container alloy grafana/alloy:v1 c9e2bc3e94ff luna stop-first"],
            [2, "Container alloy/691d7b257a41 on hazel | Stopping"],
            [3, "Container alloy/691d7b257a41 on hazel | Stopped"],
            [4, "Container alloy-ojnq on hazel | Starting"],
            [5, "Container alloy-ojnq on hazel | Running"],
            [6, "deployed"],
            [6, "Waiting for Alloy collectors on 2 machine(s)…"],
        ]),
        false,
    );

    expect(steps.map((step) => [step.kind, step.title, step.history.join(" → ")])).toEqual([
        ["note", "Deploying Alloy collectors", ""],
        ["plan", "Plan", ""],
        ["resource", "alloy/691d7b", "stopped"],
        ["resource", "alloy-ojnq", "running"],
        ["note", "Waiting for Alloy collectors on 2 machine(s)", ""],
    ]);
    expect(steps[1]?.ops).toHaveLength(2);
});
