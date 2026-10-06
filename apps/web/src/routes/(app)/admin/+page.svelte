<script lang="ts">
    import {
        Card,
        CardDescription,
        CardHeader,
        CardPanel,
        CardTitle,
    } from "$lib/components/ui/card";
    import { Button } from "$lib/components/ui/button";

    const { data } = $props();
</script>

<svelte:head><title>Admin / Stoat</title></svelte:head>
<div class="mx-auto w-full max-w-6xl space-y-4 pt-6">
    <div>
        <h1 class="text-2xl font-bold tracking-tight">
            Administration
        </h1>
        <p class="text-sm text-muted-foreground">
            Instance overview and global configuration.
        </p>
    </div>
    <div class="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {#each data.stats as stat (stat.title)}
            <Card>
                <CardHeader class="pb-2">
                    <CardTitle class="text-sm font-medium">
                        {stat.title}
                    </CardTitle>
                </CardHeader>
                <CardPanel>
                    <div class="text-2xl font-bold">{stat.count}</div>
                    <CardDescription class="text-xs">
                        {stat.description}
                    </CardDescription>
                </CardPanel>
            </Card>
        {/each}
    </div>
    <Button href="/admin/settings" variant="outline">
        System settings
    </Button>
</div>
