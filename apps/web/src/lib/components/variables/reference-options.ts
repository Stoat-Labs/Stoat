import type { AppRouterClient } from "@stoat/api/routers/index";

export type ReferenceTarget = Awaited<
    ReturnType<AppRouterClient["resources"]["listVariableReferences"]>
>[number];

type ReferenceSource = ReferenceTarget["keys"][number]["source"];

/**
 * Where the picker is: the project list, a project's resources, or a resource's variables.
 * It opens on the current project's resources.
 */
export type ReferencePage =
    | { level: "projects" }
    | { level: "resources"; projectId: string }
    | { level: "variables"; projectId: string; target: ReferenceTarget };

export type ReferenceOption = {
    id: string;
    label: string;
    // Right-aligned hint, like a resource's variable count.
    hint?: string;
    // The page this option opens; absent on a variable, which is picked.
    next?: ReferencePage;
    key?: string;
    target?: ReferenceTarget;
};

export type ReferenceGroup = { label: string; items: ReferenceOption[] };

const sources: [ReferenceSource, string][] = [
    ["variables", "Variables"],
    ["compose", "Set in Compose"],
    ["stoat", "Added by Stoat"],
];

const count = (amount: number, noun: string) => `${amount} ${noun}${amount === 1 ? "" : "s"}`;

/** Projects in server order (by name), with the current project first. */
function projects(targets: ReferenceTarget[], currentProjectId: string) {
    const byId = new Map<string, { name: string; resources: number }>();

    for (const target of targets) {
        const project = byId.get(target.projectId) ?? { name: target.projectName, resources: 0 };

        project.resources++;
        byId.set(target.projectId, project);
    }

    // Stable sort: only the current project moves.
    return [...byId].toSorted(
        ([a], [b]) => Number(b === currentProjectId) - Number(a === currentProjectId),
    );
}

// Only the current project can be opened without resources, so it is the fallback.
export function projectName(targets: ReferenceTarget[], projectId: string) {
    return targets.find((target) => target.projectId === projectId)?.projectName ?? "this project";
}

/** The options a page lists, grouped under headings. */
export function referenceGroups(
    targets: ReferenceTarget[],
    page: ReferencePage,
    currentProjectId: string,
): ReferenceGroup[] {
    if (page.level === "projects")
        return [
            {
                label: "Projects",
                items: projects(targets, currentProjectId).map(([id, project]) => ({
                    id,
                    label:
                        id === currentProjectId ? `${project.name} (this project)` : project.name,
                    hint: count(project.resources, "resource"),
                    next: { level: "resources", projectId: id },
                })),
            },
        ];

    if (page.level === "resources")
        return [
            {
                label: projectName(targets, page.projectId),
                items: targets.flatMap((target) =>
                    target.projectId === page.projectId
                        ? [
                              {
                                  id: target.id,
                                  label: target.name,
                                  hint: count(target.keys.length, "variable"),
                                  next: { level: "variables", projectId: page.projectId, target },
                              },
                          ]
                        : [],
                ),
            },
        ];

    return sources.flatMap(([source, label]) => {
        const items = page.target.keys.flatMap((entry) =>
            entry.source === source
                ? [{ id: entry.key, label: entry.key, key: entry.key, target: page.target }]
                : [],
        );

        return items.length > 0 ? [{ label, items }] : [];
    });
}
