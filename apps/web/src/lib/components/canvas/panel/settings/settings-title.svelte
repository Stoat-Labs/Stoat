<script lang="ts">
    let {
        text,
        description,
    }: { text: string; description?: string } = $props();
</script>

<h4 class="text-sm font-semibold">{text}</h4>
{#if description}
    <p class="mt-1 text-sm text-muted-foreground">
        {description}
    </p>
{/if}
