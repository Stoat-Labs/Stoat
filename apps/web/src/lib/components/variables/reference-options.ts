import type { AppRouterClient } from "@stoat/api/routers/index";

export type ReferenceTarget = Awaited<
    ReturnType<AppRouterClient["resources"]["listVariableReferences"]>
>[number];

// Step one lists resources (no key); step two lists the chosen resource's keys.
export type ReferenceOption = { target: ReferenceTarget; key?: string; search: string };

export type ReferenceGroup = { label: string; items: ReferenceOption[] };

/**
 * Picker groups: without `selected`, resources grouped by project with this project first
 * (the server sorts the rest by project name); with it, that resource's variable names.
 */
export function referenceGroups(
    targets: ReferenceTarget[],
    projectId: string,
    selected?: ReferenceTarget,
): ReferenceGroup[] {
    if (selected)
        return [
            {
                label: selected.name,
                items: selected.keys.map((key) => ({ target: selected, key, search: key })),
            },
        ];

    const byProject = new Map<string, ReferenceGroup>([
        [projectId, { label: "This project", items: [] }],
    ]);

    for (const target of targets) {
        const group = byProject.get(target.projectId) ?? { label: target.projectName, items: [] };

        group.items.push({ target, search: target.name });
        byProject.set(target.projectId, group);
    }

    return [...byProject.values()].filter((group) => group.items.length > 0);
}
