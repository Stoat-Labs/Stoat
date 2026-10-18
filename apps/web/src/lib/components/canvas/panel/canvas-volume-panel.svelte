<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import HardDrive from "@lucide/svelte/icons/hard-drive";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import Unplug from "@lucide/svelte/icons/unplug";
    import X from "@lucide/svelte/icons/x";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";
    import { cubicOut, expoOut } from "svelte/easing";
    import { prefersReducedMotion } from "svelte/motion";
    import { fly } from "svelte/transition";
    import VolumeDialog from "../controls/volume-dialog.svelte";
    import CanvasVolumeMetrics from "./canvas-volume-metrics.svelte";
    import type {
        CanvasResource,
        CanvasService,
        CanvasVolume,
        VolumeTarget,
    } from "../graph";

    let {
        resource,
        volume,
        services,
        width,
        inset,
        onclose,
        onremove,
    }: {
        resource: CanvasResource;
        volume: CanvasVolume;
        services: CanvasService[];
        /** Pixel width, shared with the canvas so it can keep the opened node in view. */
        width: number;
        /** Narrow canvases hide the graph: the panel floats over all of it, inset from the sides. */
        inset: boolean;
        onclose: () => void;
        /** Asks to delete the volume; the canvas confirms it first. */
        onremove: () => void;
    } = $props();

    const tabs = ["metrics", "settings"] as const;

    const labels = { metrics: "Metrics", settings: "Settings" };

    // Matches project-canvas, so Back steps through tabs.
    const tab = useQueryState(
        "tab",
        parseAsStringLiteral(tabs).withOptions({
            history: "push",
            shallow: true,
            scroll: false,
        }),
    );

    const active = $derived(tab.current ?? tabs[0]);

    let connecting = $state(false);

    let pending = $state(false);

    let error = $state("");

    // Edited paths by service; a field shows what is saved until it is typed in.
    let typed = $state<Record<string, string>>({});

    const targets = $derived<VolumeTarget[]>(
        services.flatMap((service) =>
            volume.services.includes(service.name)
                ? []
                : [
                      {
                          resourceId: resource.id,
                          service: service.name,
                          icon: null,
                          label:
                              services.length === 1
                                  ? resource.name
                                  : `${resource.name} / ${service.name}`,
                      },
                  ],
        ),
    );

    async function run(
        change: () => Promise<{ id: string }>,
        fallback: string,
    ) {
        pending = true;
        error = "";

        try {
            await change();
            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
            ]);

            return true;
        } catch (cause) {
            error = cause instanceof Error ? cause.message : fallback;

            return false;
        } finally {
            pending = false;
        }
    }

    const edit = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
        volume: volume.name,
    });

    async function connect(target: VolumeTarget, path: string) {
        const done = await run(
            () =>
                client.resources.attachVolume({
                    ...edit,
                    service: target.service,
                    target: path,
                }),
            "The volume could not be connected.",
        );

        if (done) connecting = false;
    }

    async function remount(service: string, current: string) {
        const path = (typed[service] ?? current).trim();

        if (path === current) return;

        const done = await run(
            () =>
                client.resources.updateVolumeMount({
                    ...edit,
                    service,
                    target: path,
                }),
            "The mount path could not be changed.",
        );

        if (done) delete typed[service];
    }

    function disconnect(service: string) {
        void run(
            () => client.resources.detachVolume({ ...edit, service }),
            "The volume could not be disconnected.",
        );
    }

    // Matches the resource panel: it travels a fifth of its width while fading.
    const enter = $derived({
        x: width * 0.2,
        duration: prefersReducedMotion.current ? 0 : 400,
        easing: expoOut,
    });

    const leave = $derived({
        x: width * 0.2,
        duration: prefersReducedMotion.current ? 0 : 250,
        easing: cubicOut,
    });

    const edge = $derived(
        inset
            ? "right-5 rounded-t-xl border"
            : "right-0 rounded-tl-xl border-t border-l",
    );
</script>

<aside
    class={[
        "absolute top-6 bottom-0 z-10 flex flex-col overflow-hidden border-border bg-card shadow-md/10",
        edge,
    ]}
    style:width="{width}px"
    aria-label="{volume.name} volume"
    in:fly|global={enter}
    out:fly|global={leave}
>
    <header class="flex items-center gap-4 px-12 pt-12 pb-6">
        <HardDrive
            class="size-8 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
        />
        <h2 class="min-w-0 flex-1 truncate text-2xl font-semibold">
            {volume.name}
        </h2>
        <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close details"
            onclick={onclose}
        >
            <X class="size-4" aria-hidden="true" />
        </Button>
    </header>

    <!-- Railway's volume tabs: Metrics, then Settings. -->
    <div
        class="flex shrink-0 gap-8 border-b border-border px-12"
        role="tablist"
        aria-label="{volume.name} sections"
    >
        {#each tabs as name (name)}
            <button
                type="button"
                role="tab"
                aria-selected={active === name}
                class={[
                    "relative shrink-0 pb-3 text-base transition-colors",
                    active === name
                        ? "text-foreground after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-foreground"
                        : "text-muted-foreground hover:text-foreground",
                ]}
                onclick={() => void tab.set(name)}
            >
                {labels[name]}
            </button>
        {/each}
    </div>

    <div
        class="min-h-0 flex-1 overflow-y-auto px-12 pt-8 pb-12"
        role="tabpanel"
    >
        {#if active === "metrics"}
            <CanvasVolumeMetrics
                projectId={resource.projectId}
                resourceId={resource.id}
                volume={volume.name}
                mountedBy={volume.services}
            />
        {:else}
            <div class="space-y-10">
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
                <section class="space-y-4">
                    <h3 class="text-xl text-muted-foreground">
                        Connection
                    </h3>
                    {#each volume.mounts as mount (mount.service)}
                        <div class="space-y-2">
                            <p class="text-sm font-semibold">
                                Mount Path
                                {#if services.length > 1}
                                    <span
                                        class="font-normal text-muted-foreground"
                                    >
                                        · {mount.service}
                                    </span>
                                {/if}
                            </p>
                            <div class="flex gap-2">
                                <Input
                                    class="font-mono"
                                    aria-label="Mount path in {mount.service}"
                                    spellcheck={false}
                                    disabled={pending}
                                    bind:value={
                                        () =>
                                            typed[mount.service] ??
                                            mount.target,
                                        (value) =>
                                            (typed[mount.service] =
                                                value)
                                    }
                                    onblur={() =>
                                        void remount(
                                            mount.service,
                                            mount.target,
                                        )}
                                    onkeydown={(event) => {
                                        if (event.key === "Enter")
                                            event.currentTarget.blur();
                                    }}
                                />
                                <Button
                                    variant="outline"
                                    disabled={pending}
                                    onclick={() =>
                                        disconnect(mount.service)}
                                >
                                    <Unplug
                                        class="size-4"
                                        aria-hidden="true"
                                    />
                                    Disconnect
                                </Button>
                            </div>
                        </div>
                    {/each}
                    {#if targets.length > 0}
                        <Button
                            variant="outline"
                            disabled={pending}
                            onclick={() => {
                                error = "";
                                connecting = true;
                            }}
                        >
                            Connect to service
                        </Button>
                    {/if}
                </section>
                <section class="space-y-4">
                    <h3 class="text-xl text-destructive-foreground">
                        Delete Volume
                    </h3>
                    <Button
                        variant="destructive"
                        disabled={pending}
                        onclick={onremove}
                    >
                        <Trash2 class="size-4" aria-hidden="true" />
                        Delete Volume
                    </Button>
                </section>
            </div>
        {/if}
    </div>
</aside>

{#if connecting}
    <VolumeDialog
        {targets}
        volume={volume.name}
        {pending}
        {error}
        onsubmit={(target, path) => void connect(target, path)}
        onclose={() => (connecting = false)}
    />
{/if}
