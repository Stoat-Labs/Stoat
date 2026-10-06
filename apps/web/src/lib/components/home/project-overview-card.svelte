<script lang="ts" module>
    export type ResourceStatus =
        | "queued"
        | "running"
        | "ready"
        | "failed"
        | "cancelled"
        | null;

    export type ProjectOverview = {
        id: string;
        name: string;
        description: string | null;
        clusterId: string;
        clusterName: string;
        lastActivityAt: Date | string;
        resources: {
            id: string;
            name: string;
            status: ResourceStatus;
        }[];
    };

    export const statusLabels: Record<
        Exclude<ResourceStatus, null>,
        string
    > = {
        queued: "Deploy queued",
        running: "Deploying",
        ready: "Deployed",
        failed: "Deploy failed",
        cancelled: "Deploy cancelled",
    };

    export function dotClass(status: ResourceStatus) {
        switch (status) {
            case "ready":
                return "bg-success";
            case "failed":
                return "bg-destructive";
            case "queued":
            case "running":
                return "animate-pulse bg-warning";
            default:
                return "bg-muted-foreground/40";
        }
    }
</script>

<script lang="ts">
    import ProjectCard from "$lib/components/projects/project-card.svelte";

    let {
        project,
        showCluster = true,
    }: {
        project: ProjectOverview;
        showCluster?: boolean;
    } = $props();
</script>

<ProjectCard
    name={project.name}
    description={project.description}
    resourceCount={project.resources.length}
    clusterName={showCluster ? project.clusterName : undefined}
    href="/projects/{project.id}"
/>
