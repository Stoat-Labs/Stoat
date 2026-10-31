import { render } from "svelte/server";
import { expect, it } from "vite-plus/test";
import ProjectCard, {
    type ProjectCardResource,
} from "../../apps/web/src/lib/components/projects/project-card.svelte";

const resources: ProjectCardResource[] = [
    {
        id: "api",
        name: "Backend service",
        icon: "https://icons.example.test/api.svg",
        type: "compose",
        image: null,
        status: "failed",
    },
    {
        id: "web",
        name: "Frontend service",
        icon: null,
        type: "compose",
        image: null,
        status: "ready",
    },
];

function card(props: Partial<Parameters<typeof render<typeof ProjectCard>>[1]["props"]> = {}) {
    return render(ProjectCard, {
        props: {
            name: "Storefront",
            resources,
            clusterName: "Production",
            href: "/projects/project-1",
            onfavorite: () => {},
            ...props,
        },
    }).body;
}

it("draws Railway's miniature canvas: a tile per resource and the deploy count", () => {
    const body = card();

    expect(body).toContain('href="/projects/project-1"');
    expect(body).toContain("Storefront");
    expect(body).toContain('src="https://icons.example.test/api.svg"');
    expect(body).toContain("Backend service");
    expect(body).toContain("Frontend service");
    expect(body).toMatch(/Production[\s\S]*1\/2\s+deployed/);
    // A failed deploy wins the status dot.
    expect(body).toContain("bg-destructive");
    expect(body).toContain('aria-label="Add Storefront to favorites"');
    expect(body).toContain('aria-pressed="false"');
});

it("leaves the cluster out when it isn't given", () => {
    const body = card({ clusterName: undefined });

    expect(body).not.toContain("Production");
    expect(body).toMatch(/1\/2\s+deployed/);
});

it("marks starred projects and counts tiles past the first eight", () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
        ...resources[1]!,
        id: `r${index}`,
        name: `Resource ${index}`,
    }));

    const body = card({ favorite: true, resources: many });

    expect(body).toContain('aria-pressed="true"');
    expect(body).toContain("+3");
    expect(body).toContain("Resource 6");
    expect(body).not.toContain("Resource 7");
});

it("shows an empty project as having no resources", () => {
    const body = card({ resources: [] });

    expect(body).toContain("No resources");
    expect(body).not.toContain("deployed");
});

it("spells out failed and deploying resources, since the dot is decorative", () => {
    const body = card({
        resources: [...resources, { ...resources[1]!, id: "worker", status: "running" }],
    });

    expect(body).toContain("1 failed · 1 deploying · 1/3 deployed");
});

it("renders no stray script text", () => {
    expect(card()).not.toContain("const ");
});
