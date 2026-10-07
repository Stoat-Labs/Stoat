// Resolve the web package's dependency because these tests live outside that package.
import {
    QueryClient,
    setQueryClientContext,
} from "../../apps/web/node_modules/@tanstack/svelte-query";
import { setContext } from "svelte";
import { render } from "svelte/server";
import { expect, it } from "vite-plus/test";
import DeploymentsTable from "../../apps/web/src/lib/components/deployments/deployments-table.svelte";
import { setHeaderActions } from "../../apps/web/src/lib/components/sidebar/header-actions";
import { orpc } from "../../apps/web/src/lib/api/orpc";
import { listPageSize } from "../../apps/web/src/lib/params/query-params";

function renderDeployments(latest: number | undefined, search: string, resourceId?: string) {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const limit = latest ?? listPageSize;

    const status: "failed" | undefined = latest === undefined ? "failed" : undefined;

    const input = {
        status,
        limit,
        offset: latest === undefined ? 2 * limit : 0,
        resourceId,
    };

    const items = Array.from({ length: limit }, (_, index) => ({
        id: `deployment-${index}`,
        name: "DeployResource",
        status: "failed",
        spec: null,
        clusterId: "cluster",
        clusterName: "Production",
        projectId: "project",
        projectName: "Storefront",
        resourceId: resourceId ?? `resource-${index}`,
        resourceName: `Service ${index}`,
        createdAt: new Date("2026-09-30T12:00:00Z"),
        updatedAt: new Date("2026-09-30T12:01:00Z"),
        finishedAt: new Date("2026-09-30T12:01:00Z"),
    }));

    cache.setQueryData(orpc.cluster.listAllDeployments.queryKey({ input }), { items, total: 80 });

    function TableWithContext(...args: Parameters<typeof DeploymentsTable>) {
        setQueryClientContext(cache);
        setHeaderActions({});
        setContext(Symbol.for("nuqs-svelte-adapter"), {
            useAdapter: () => ({ searchParams: () => new URLSearchParams(search) }),
        });

        return DeploymentsTable(...args);
    }

    try {
        return render(TableWithContext, { props: { latest, resourceId } }).body;
    } finally {
        cache.clear();
    }
}

it("shows only the latest N deployments independently of URL page and status filters", () => {
    for (const limit of [1, 5, 10]) {
        const body = renderDeployments(limit, "page=3&status=failed");
        expect(body).toContain("Recent deployments");
        expect(body).toContain(`${limit} most recent`);
        expect(body).toContain("View all deployments");
        expect(body.match(/href="\/deployments\/deployment-/g)).toHaveLength(limit);
        expect(body).toContain("Storefront / Service 0");
        expect(body).not.toContain("Loading table row");
        expect(body).not.toContain('data-slot="pagination"');
    }
});

it("preserves resource scoping and contextual deployment links in latest mode", () => {
    const body = renderDeployments(3, "page=3&status=failed", "resource");
    expect(body).toContain("Recent deployments");
    expect(
        body.match(/href="\/projects\/project\/resource\/deployments\/deployment-/g),
    ).toHaveLength(3);
    expect(body).not.toContain("View all deployments");
});

it("keeps URL filtering and pagination for the full deployments view", () => {
    const body = renderDeployments(undefined, "page=3&status=failed");
    expect(body).toContain(`${2 * listPageSize + 1}–${3 * listPageSize} of 80`);
    expect(body).toContain('data-slot="pagination"');
    expect(body).not.toContain("Recent deployments");
    expect(body).not.toContain("View all deployments");
});
