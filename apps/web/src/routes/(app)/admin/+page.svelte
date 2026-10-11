<script lang="ts">
    import { enhance } from "$app/forms";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardDescription,
        CardHeader,
        CardPanel,
        CardTitle,
    } from "$lib/components/ui/card";
    import { Label } from "$lib/components/ui/label";
    import { Switch } from "$lib/components/ui/switch";
    import { onMount } from "svelte";

    const { data, form } = $props();

    let enabled = $derived(data.signupsEnabled);

    let pending = $state(false);

    let ready = $state(false);

    onMount(() => {
        ready = true;
    });
</script>

<svelte:head><title>Admin / Stoat</title></svelte:head>
<div class="w-full space-y-6 pt-6">
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
    <Card class="w-full max-w-3xl">
        <CardHeader>
            <CardTitle>System settings</CardTitle>
            <CardDescription>
                Instance-wide configuration.
            </CardDescription>
        </CardHeader>
        <CardPanel>
            <form
                method="POST"
                class="space-y-4"
                aria-busy={pending}
                use:enhance={() => {
                    pending = true;
                    return async ({ update }) => {
                        try {
                            await update({ reset: false });
                        } finally {
                            pending = false;
                        }
                    };
                }}
            >
                <div class="flex items-center justify-between gap-4">
                    <div class="space-y-1">
                        <Label for="signups-enabled">
                            Allow user signups
                        </Label>
                        <p
                            id="signups-description"
                            class="text-sm text-muted-foreground"
                        >
                            Allow new users to create an account.
                            Existing users can still log in.
                        </p>
                    </div>
                    <Switch
                        id="signups-enabled"
                        bind:checked={enabled}
                        disabled={!ready || pending}
                        aria-describedby="signups-description"
                    />
                    <input
                        type="hidden"
                        name="signupsEnabled"
                        value={enabled ? "true" : "false"}
                    />
                </div>
                <div class="flex flex-wrap items-center gap-3 pt-2">
                    <Button
                        type="submit"
                        disabled={!ready}
                        loading={pending}
                    >
                        Save changes
                    </Button>
                    <p
                        class="text-sm"
                        class:text-destructive-foreground={Boolean(
                            form?.error,
                        )}
                        aria-live="polite"
                    >
                        {form?.error ??
                            (form?.saved ? "Settings saved." : "")}
                    </p>
                </div>
            </form>
        </CardPanel>
    </Card>
</div>
