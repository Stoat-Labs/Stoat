<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import { getCanvasActions } from "../../context";
    import type { CanvasResource } from "../../graph";
    import SettingsTitle from "./settings-title.svelte";

    let {
        resource,
        isBucket,
        isInternal,
        shows,
    }: {
        resource: CanvasResource;
        isBucket: boolean;
        isInternal: boolean;
        shows: (...words: string[]) => boolean;
    } = $props();

    const actions = getCanvasActions();
</script>

<div>
    <SettingsTitle text={"Name"} />
    <div
        class="mt-3 flex items-center gap-3 rounded-md bg-muted/60 px-4 py-3"
    >
        <span class="min-w-0 flex-1 truncate">
            {resource.name}
        </span>
        <Button
            size="sm"
            variant="outline"
            onclick={() => actions.edit("rename", resource.id)}
        >
            Rename
        </Button>
    </div>
</div>
<div>
    <SettingsTitle
        text={"Icon"}
        description={"Shown on the canvas and in the sidebar."}
    />
    <div class="mt-3 flex flex-wrap gap-2">
        <Button
            variant="outline"
            onclick={() => actions.edit("icon-upload", resource.id)}
        >
            Upload image
        </Button>
        <Button
            variant="outline"
            onclick={() => actions.edit("icon-link", resource.id)}
        >
            Use a link
        </Button>
    </div>
</div>
{#if !isBucket && !isInternal && shows("project", "move", "copy", "duplicate")}
    <div>
        <SettingsTitle
            text={"Project"}
            description={"Move it to another project, or copy its configuration into one. A deployed resource can't move to another cluster."}
        />
        <div class="mt-3 flex flex-wrap gap-2">
            <Button
                variant="outline"
                onclick={() => actions.edit("duplicate", resource.id)}
            >
                Duplicate
            </Button>
            <Button
                variant="outline"
                onclick={() => actions.edit("move", resource.id)}
            >
                Move to Project
            </Button>
            <Button
                variant="outline"
                onclick={() => actions.edit("copy", resource.id)}
            >
                Copy to Project
            </Button>
        </div>
    </div>
{/if}
