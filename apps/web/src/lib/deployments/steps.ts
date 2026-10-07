import type { LogLevel } from "$lib/resources/logs";

export type DeploymentLine = { time: number; message: string; level: LogLevel; event?: string };

export type StepState = "active" | "done" | "error" | "stopped";

export type DeploymentStep = {
    key: string;
    kind: "note" | "plan" | "resource" | "pull";
    state: StepState;
    title: string;
    /** Non-container resource kind, e.g. "Volume". */
    label?: string;
    machine?: string;
    detail?: string;
    /** Settled states, oldest first; an in-progress state is replaced by its successor. */
    history: string[];
    ops: { title: string; detail: string }[];
    monitor?: { since: number; seconds: number };
    pull?: { percent: number; current: number; total: number };
    time: number;
};

// Status lines that only narrate the resource workflow; the step list and final line cover them.
const noise =
    /^(Loading deployment input|Loading the cluster domain|Formatting Compose snapshot|Formatted \d+ service|Deploying Compose to the cluster|Saving the deployed Compose snapshot)/u;

const resourcePart = /^(Container|Volume|Pre-deploy hook|Old pre-deploy hook) (.+) on (\S+)$/u;

const imagePart = /^Image (.+) on (\S+)$/u;

const layerPart = /^[0-9a-f]{12} on \S+$/u;

const suffix = /(?: \(\d+%\))?(?: \[(\d+)\/(\d+)\])?$/u;

const shortIds = (text: string) => text.replace(/\b([0-9a-f]{6})[0-9a-f]{6,}\b/gu, "$1");

// Uncloud reports in-progress states as gerunds; "running" is its terminal state for containers without a health check.
const working = (state: string | undefined) => !!state?.endsWith("ing") && state !== "running";

function sentence(text: string) {
    const [title = text, ...rest] = text.replace(/[.…]+$/u, "").split(/\.\s+/u);

    return { title, detail: rest.join(". ") || undefined };
}

function seconds(status: string) {
    const match = status.match(/\((?:(\d+)m)?(\d+(?:\.\d+)?)s\)/u);

    return match ? Number(match[1] ?? 0) * 60 + Number(match[2]) : 0;
}

const planHeader = /^Deployment plan: (\d+) operation/u;

const progressLine = /^(?:(?:Old )?[Pp]re-deploy hook|Container|Volume|Image) .+ on \S+ \| /u;

// Logs stored without event tags (older runs, or an out-of-date worker) still follow the same text shapes.
function inferEvent(text: string, inPlan: boolean) {
    if (planHeader.test(text) || inPlan) return "plan";

    if (progressLine.test(text)) return "progress";

    if (text === "deployed") return "complete";

    return undefined;
}

export function deploymentSteps(lines: DeploymentLine[], running: boolean) {
    const steps: DeploymentStep[] = [];
    const byKey = new Map<string, DeploymentStep>();

    const layers = new Map<
        string,
        Map<string, { current: number; total: number; done: boolean }>
    >();

    const upsert = (key: string, step: Omit<DeploymentStep, "key" | "history" | "ops">) => {
        const found = byKey.get(key);

        if (found) return Object.assign(found, { time: step.time });
        const created: DeploymentStep = { key, history: [], ops: [], ...step };
        byKey.set(key, created);
        steps.push(created);

        return created;
    };

    // Plan operations that the latest "Deployment plan: N operation(s)" header still has to announce.
    let planLeft = 0;

    for (const [index, line] of lines.entries()) {
        const text = line.message.trim();
        const event = line.event ?? inferEvent(text, planLeft > 0);
        const header = text.match(planHeader);

        if (event !== "plan") planLeft = 0;
        else if (header) planLeft = Number(header[1]);
        else planLeft -= 1;

        if (event === "plan") {
            const plan = upsert("plan", {
                kind: "plan",
                state: "done",
                title: "Plan",
                time: line.time,
            });

            if (text.startsWith("Deployment plan:")) continue;

            const [action = "", resource = "", name = "", ...rest] = text.split(/\s+/u);

            plan.ops.push({
                title: [action, resource === "container" ? "" : resource, name]
                    .join(" ")
                    .replace(/\s+/gu, " "),
                detail: shortIds(rest.join(" · ")),
            });
            continue;
        }

        if (event === "complete" || event === "ready" || text === "Resource deployment is ready.")
            continue;

        if (event === "progress") {
            const [, current, total] = text.match(suffix) ?? [];
            const parts = text.replace(suffix, "").split(" | ");
            const imageAt = parts.findIndex((part) => imagePart.test(part));

            if (imageAt >= 0) {
                const [, image = "", machine] = parts[imageAt]!.match(imagePart) ?? [];
                const key = `pull:${image}@${machine}`;

                const step = upsert(key, {
                    kind: "pull",
                    state: "active",
                    title: image,
                    machine,
                    time: line.time,
                    pull: { percent: 0, current: 0, total: 0 },
                });

                const rest = parts.slice(imageAt + 1);
                const known = layers.get(key) ?? new Map();
                layers.set(key, known);

                if (rest[0] && layerPart.test(rest[0])) {
                    const layer = known.get(rest[0]) ?? { current: 0, total: 0, done: false };
                    known.set(rest[0], layer);

                    if (rest[1] === "Downloading" && current && total)
                        Object.assign(layer, { current: Number(current), total: Number(total) });

                    if (/complete|Already exists/iu.test(rest[1] ?? "")) layer.done = true;
                } else if (line.level === "error") {
                    Object.assign(step, { state: "error", detail: rest.at(-1) });
                } else if (rest.at(-1) === "Pulled") {
                    step.state = "done";
                }

                const all = [...known.values()];
                const bytes = all.reduce((sum, layer) => sum + layer.total, 0);

                const got = all.reduce(
                    (sum, layer) => sum + (layer.done ? layer.total : layer.current),
                    0,
                );

                const percent =
                    step.state === "done"
                        ? 100
                        : bytes
                          ? (got / bytes) * 100
                          : all.length
                            ? (all.filter((layer) => layer.done).length / all.length) * 100
                            : 0;

                step.pull = {
                    percent: Math.min(100, Math.round(percent)),
                    current: got,
                    total: bytes,
                };
                continue;
            }

            const resourceAt = parts.findIndex((part) => resourcePart.test(part));

            if (resourceAt >= 0) {
                const [, kind, name = "", machine] = parts[resourceAt]!.match(resourcePart) ?? [];

                const step = upsert(`resource:${parts[resourceAt]}`, {
                    kind: "resource",
                    state: "active",
                    title: shortIds(name),
                    label: kind === "Container" ? undefined : kind,
                    machine,
                    time: line.time,
                });

                const status = parts.length > resourceAt + 1 ? parts.at(-1)!.trim() : "Done";
                const base = status.replace(/\s*\(.*\)$/u, "").toLowerCase();
                const last = step.history.at(-1);

                if (working(last)) step.history[step.history.length - 1] = base;
                else if (last !== base) step.history.push(base);

                if (base === "monitoring")
                    step.monitor ??= { since: line.time, seconds: seconds(status) };
                step.state =
                    line.level === "error" || /^(unhealthy|error)/u.test(base)
                        ? "error"
                        : working(base)
                          ? "active"
                          : "done";
                step.detail =
                    step.state === "error"
                        ? (status.match(/\((.+)\)$/u)?.[1] ?? undefined)
                        : undefined;
                continue;
            }
        }

        if (line.level !== "error" && noise.test(text)) continue;

        const previous = steps.at(-1);
        const { title, detail } = sentence(text);

        // Collapse repeats such as "Still verifying ingestion (attempt 3/40)".
        if (
            previous?.kind === "note" &&
            previous.title.replace(/\d+/gu, "#") === title.replace(/\d+/gu, "#")
        ) {
            Object.assign(previous, {
                title,
                detail,
                time: line.time,
                state: line.level === "error" ? "error" : previous.state,
            });
            continue;
        }

        upsert(`note:${index}`, {
            kind: "note",
            state: line.level === "error" ? "error" : "done",
            title,
            detail,
            time: line.time,
        });
    }

    const last = steps.at(-1);

    for (const step of steps) {
        if (step.kind === "note" && step.state !== "error")
            step.state = running && step === last ? "active" : "done";

        if (!running && step.state === "active") step.state = "stopped";
    }

    return steps;
}
