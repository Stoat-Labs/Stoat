// Resolve the web package's dependency because these tests live outside that package.
import {
    QueryClient,
    setQueryClientContext,
} from "../../apps/web/node_modules/@tanstack/svelte-query";
import { setContext } from "svelte";
import { render } from "svelte/server";
import { expect, it } from "vite-plus/test";
import { orpc } from "../../apps/web/src/lib/api/orpc";
import ResourceLogs from "../../apps/web/src/lib/components/projects/resource-logs.svelte";

const input = { projectId: "project", resourceId: "resource" };

const timestamp = new Date("2026-10-06T00:00:00Z");

const resource = {
    id: input.resourceId,
    projectId: input.projectId,
    name: "Resource",
    description: null,
    icon: null,
    type: "compose",
    spec: null,
    draftSpec: null,
    settings: null,
    gitConnectionId: null,
    gitSource: null,
    createdAt: timestamp,
    updatedAt: timestamp,
} as const;

type LogServices = Awaited<
    ReturnType<ReturnType<typeof orpc.resources.listLogServices.queryOptions>["queryFn"]>
>;

const oneService: LogServices = {
    services: [{ id: "service-1", name: "api" }],
    historyAvailable: true,
    retentionDays: 14,
};

// Seeded queries render as loaded; anything left unseeded stays pending, as on first load.
function renderLogs(search: string, loadedResource: boolean, services: LogServices | null) {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });

    if (loadedResource)
        cache.setQueryData(orpc.resources.getResource.queryKey({ input }), resource);

    if (services) cache.setQueryData(orpc.resources.listLogServices.queryKey({ input }), services);

    function LogsWithContext(...args: Parameters<typeof ResourceLogs>) {
        setQueryClientContext(cache);
        setContext(Symbol.for("nuqs-svelte-adapter"), {
            useAdapter: () => ({ searchParams: () => new URLSearchParams(search) }),
        });

        return ResourceLogs(...args);
    }

    try {
        return render(LogsWithContext, { props: input }).body;
    } finally {
        cache.clear();
    }
}

it("keeps the logs workspace skeleton until both queries are ready", () => {
    const noServices: LogServices = { services: [], historyAvailable: false, retentionDays: null };

    for (const [resourceLoaded, servicesLoaded] of [
        [false, false],
        [false, true],
        [true, false],
        [true, true],
    ]) {
        const body = renderLogs("", resourceLoaded, servicesLoaded ? noServices : null);

        if (!resourceLoaded || !servicesLoaded) {
            expect(body).toContain('loading-label="Loading logs"');
            expect(body).toContain('data-slot="frame"');
            expect(body).toContain('aria-label="Filter loaded logs"');
            expect(body).toContain('aria-label="Log activity"');
            expect(body.match(/class="log-row /g)).toHaveLength(16);
            expect(body).not.toContain("No deployed services");
        } else {
            expect(body).toContain("No deployed services");
            expect(body).not.toContain("<phantom-ui");
        }
    }
});

it("restores the search controls from a shared URL", () => {
    const body = renderLogs(
        "logMode=search&logRange=custom&logLevel=error&logWrap=true",
        true,
        oneService,
    );

    expect(body).toContain('aria-label="Search log messages"');
    expect(body).toContain('id="log-start"');
    expect(body).toContain('aria-label="Wrap log lines"');
    expect(body).toContain('aria-pressed="true"');
});

it("restores pause and scroll controls from a shared URL", () => {
    const body = renderLogs("logPaused=true&logFollowing=false&logScroll=42", true, oneService);

    expect(body).toContain("Resume");
    expect(body).toContain("Jump to latest");
});

it("restores a fixed time bucket from a shared URL", () => {
    const body = renderLogs("logBucket=0%3A0%3A24000", true, oneService);

    expect(body).toContain("Show all times");
});
