import { render } from "svelte/server";
import { expect, it } from "vite-plus/test";
import ProjectOverviewCard, {
    type ProjectOverview,
} from "../../apps/web/src/lib/components/home/project-overview-card.svelte";
import ProjectCard from "../../apps/web/src/lib/components/projects/project-card.svelte";

const project: ProjectOverview = {
    id: "project-1",
    name: "Storefront",
    description: "Customer-facing services",
    clusterId: "cluster-1",
    clusterName: "Production",
    lastActivityAt: "2026-09-30T12:00:00Z",
    resources: [
        { id: "api", name: "Backend service", status: "failed" },
        { id: "web", name: "Frontend service", status: "ready" },
    ],
};

it("reuses the projects card with cluster context instead of deployment details", () => {
    const { body } = render(ProjectOverviewCard, { props: { project } });

    const shared = render(ProjectCard, {
        props: {
            name: project.name,
            description: project.description,
            resourceCount: project.resources.length,
            clusterName: project.clusterName,
            href: `/projects/${project.id}`,
        },
    }).body;

    expect(body).toBe(shared);
    expect(body).toContain('href="/projects/project-1"');
    expect(body).toContain("Storefront");
    expect(body).toContain("Customer-facing services");
    expect(body).toMatch(/2\s+resources/);
    expect(body).toContain("Production");
    expect(body).not.toContain("Backend service");
    expect(body).not.toContain("Frontend service");
    expect(body).not.toContain("Deploy failed");
    expect(body).not.toContain("Updated");
    expect(body).not.toContain("<button");
});

it("hides redundant cluster context in a filtered view", () => {
    const { body } = render(ProjectOverviewCard, {
        props: { project, showCluster: false },
    });

    expect(body).not.toContain("Production");
    expect(body).toContain("Storefront");
    expect(body).toMatch(/2\s+resources/);
});

it("supports empty projects and optional descriptions", () => {
    const { body } = render(ProjectOverviewCard, {
        props: { project: { ...project, description: "  ", resources: [] } },
    });

    expect(body).toMatch(/0\s+resources/);
    expect(body).not.toContain('data-slot="card-description"');
});

it("keeps the projects listing free of cluster metadata by default", () => {
    const { body } = render(ProjectCard, {
        props: { name: "Storefront", resourceCount: 1, href: "/projects/project-1" },
    });

    expect(body).toMatch(/1\s+resource\b/);
    expect(body).not.toContain("resources");
    expect(body).not.toContain("Production");
});
