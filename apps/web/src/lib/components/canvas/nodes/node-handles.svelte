<script lang="ts">
    import { Handle, Position } from "@xyflow/svelte";

    // Edges need a handle on each side to attach to; connecting by hand is off, so they stay hidden.
    const sides = [
        ["top", Position.Top],
        ["right", Position.Right],
        ["bottom", Position.Bottom],
        ["left", Position.Left],
    ] as const;
</script>

{#each sides as [id, position] (id)}
    <Handle
        {id}
        type="source"
        {position}
        isConnectable={false}
        class="pointer-events-none! opacity-0!"
    />
{/each}
