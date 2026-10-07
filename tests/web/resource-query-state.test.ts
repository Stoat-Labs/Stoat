import {
    QueryClient,
    setQueryClientContext,
} from "../../apps/web/node_modules/@tanstack/svelte-query";
import { setContext } from "svelte";
import { render } from "svelte/server";
import { describe, expect, it } from "vite-plus/test";
import { orpc } from "../../apps/web/src/lib/api/orpc";
import CreatePage from "../../apps/web/src/routes/(app)/projects/[projectId]/create/[source]/+page.svelte";
import CatalogPage from "../../apps/web/src/routes/(app)/projects/[projectId]/create/+page.svelte";

const templates = [
    {
        appId: "cache",
        type: "compose",
        name: "Cache template",
        description: "A cache service",
        logo: null,
        tags: ["storage"],
        versions: [
            {
                version: "2",
                services: [{ name: "cache-v2", image: "redis:7", volumes: [] }],
                required: ["PASSWORD"],
                secrets: [],
            },
            {
                version: "1",
                services: [{ name: "cache-v1", image: "redis:6", volumes: [] }],
                required: [],
                secrets: [],
            },
        ],
    },
    {
        appId: "worker",
        type: "compose",
        name: "Worker template",
        description: "A background worker",
        logo: null,
        tags: ["jobs"],
        versions: [{ version: "1", services: [], required: [], secrets: [] }],
    },
];

function renderPage(component: typeof CreatePage, source: string, search = "") {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    cache.setQueryData(orpc.projects.getProject.queryKey({ input: { projectId: "project" } }), {
        id: "project",
        name: "Project",
        isInternal: false,
        description: null,
        clusterId: "cluster",
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-01"),
    });
    cache.setQueryData(orpc.resources.listTemplates.queryKey(), templates);
    cache.setQueryData(orpc.connections.list.queryKey(), {
        organizationId: "organization",
        oauthProviders: [],
        canManage: true,
        connections: [
            {
                id: "connection-a",
                name: "My Git",
                provider: "github",
                serverUrl: "https://github.com",
                authType: "token",
                account: null,
                repositories: [],
                hasCredentials: true,
                createdAt: new Date("2026-01-01"),
                updatedAt: new Date("2026-01-01"),
            },
        ],
    });
    cache.setQueryData(
        orpc.connections.getRepositories.queryKey({ input: { connectionId: "connection-a" } }),
        {
            repositories: [
                { url: "https://github.com/acme/app.git", name: "acme/app", defaultBranch: "main" },
            ],
            truncated: false,
        },
    );

    function PageWithContext(...args: Parameters<typeof CreatePage>) {
        setQueryClientContext(cache);
        setContext("__request__", {
            page: {
                params: { projectId: "project", source },
                url: new URL(`https://stoat.test/projects/project/create/${source}?${search}`),
            },
        });
        setContext(Symbol.for("nuqs-svelte-adapter"), {
            useAdapter: () => ({ searchParams: () => new URLSearchParams(search) }),
        });

        return component(...args);
    }

    try {
        return render(PageWithContext).body;
    } finally {
        cache.clear();
    }
}

describe("resource creation URL state", () => {
    it("restores name, description, and template version on the initial render", () => {
        const body = renderPage(
            CreatePage,
            "cache",
            "name=Restored+cache&description=Shared+draft&templateVersion=1",
        );

        expect(body).toContain('value="Restored cache"');
        expect(body).toContain("Shared draft");
        expect(body).toContain("cache-v1");
        expect(body).not.toContain("cache-v2");
    });

    it("uses template defaults without requiring a URL write", () => {
        const body = renderPage(CreatePage, "cache");
        expect(body).toContain('value="Cache template"');
        expect(body).toContain("cache-v2");
        expect(body).not.toContain('id="resource-description"');
    });

    it("preserves an explicitly empty name instead of restoring the template default", () => {
        const body = renderPage(CreatePage, "cache", "name=");
        expect(body).not.toContain('value="Cache template"');
    });

    it("restores the description toggle and safely defaults invalid query values", () => {
        expect(renderPage(CreatePage, "cache", "showDescription=true")).toContain(
            'id="resource-description"',
        );

        const body = renderPage(
            CreatePage,
            "cache",
            "showDescription=invalid&templateVersion=missing",
        );

        expect(body).not.toContain('id="resource-description"');
        expect(body).toContain("cache-v2");
        expect(renderPage(CreatePage, "compose")).toContain('id="resource-description"');
    });

    it("allows hiding the description for every source and offers removal when visible", () => {
        for (const source of ["cache", "compose", "git"]) {
            const hidden = renderPage(CreatePage, source, "showDescription=false");
            expect(hidden).not.toContain('id="resource-description"');
            expect(hidden).toContain("+ Add description");
            expect(hidden).not.toContain('aria-label="Remove description"');

            const visible = renderPage(CreatePage, source, "showDescription=true");
            expect(visible).toContain('id="resource-description"');
            expect(visible).toContain('aria-label="Remove description"');
        }
    });

    it("restores Git connection, repository, branch, and compose path", () => {
        const search = new URLSearchParams({
            name: "Git resource",
            connectionId: "connection-a",
            repositoryUrl: "https://github.com/acme/app.git",
            branch: "release/stable",
            path: "deploy/compose.yaml",
        });

        const body = renderPage(CreatePage, "git", search.toString());
        expect(body).toContain("My Git");
        expect(body).toContain("acme/app");
        expect(body).toContain('value="release/stable"');
        expect(body).toContain('value="deploy/compose.yaml"');
    });

    it("does not restore secret template variables from query parameters", () => {
        const body = renderPage(
            CreatePage,
            "cache",
            "variables=secret-value&PASSWORD=secret-value",
        );

        expect(body).toContain('id="template-variable-PASSWORD"');
        expect(body).not.toContain("secret-value");
    });
});

describe("template catalog URL filters", () => {
    it("restores search and category filters", () => {
        const search = renderPage(CatalogPage, "", "q=background");
        expect(search).toContain('value="background"');
        expect(search).toContain("Worker template");
        expect(search).not.toContain("Cache template");
        const category = renderPage(CatalogPage, "", "tag=storage");
        expect(category).toContain("Cache template");
        expect(category).not.toContain("Worker template");
    });
});
