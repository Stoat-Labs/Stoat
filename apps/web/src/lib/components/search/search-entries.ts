import { projectHref, resourceHref } from "$lib/api/hrefs";

export type SearchEntry = {
    label: string;
    /** Shown after the label, and searched with it. */
    hint: string;
    href: string;
    kind: "add" | "project" | "resource";
    icon: string | null;
    type: string | null;
};

export type SearchGroup = { label: string; items: SearchEntry[] };

type Project = {
    id: string;
    name: string;
    clusterName: string;
    resources: { id: string; name: string; icon: string | null; type: string | null }[];
};

/** Everything the palette can open; on a project's canvas, adding to it comes first. */
export function searchGroups(projects: Project[], currentProjectId?: string): SearchGroup[] {
    const current = projects.find((project) => project.id === currentProjectId);

    const groups: SearchGroup[] = [
        {
            label: "Projects",
            items: projects.map((project) => ({
                label: project.name,
                hint: project.clusterName,
                href: projectHref(project.id),
                kind: "project",
                icon: null,
                type: null,
            })),
        },
        {
            label: "Resources",
            items: projects.flatMap((project) =>
                project.resources.map((resource) => ({
                    label: resource.name,
                    hint: project.name,
                    href: resourceHref(project.id, resource.id),
                    kind: "resource",
                    icon: resource.icon,
                    type: resource.type,
                })),
            ),
        },
    ];

    if (current)
        groups.unshift({
            label: current.name,
            items: [
                {
                    label: "Add to this project",
                    hint: "",
                    href: `${projectHref(current.id)}?add=root`,
                    kind: "add",
                    icon: null,
                    type: null,
                },
            ],
        });

    return groups.filter((group) => group.items.length > 0);
}
