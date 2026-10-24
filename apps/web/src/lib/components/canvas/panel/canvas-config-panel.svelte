<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Input } from "$lib/components/ui/input";
    import FileCog from "@lucide/svelte/icons/file-cog";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import Unplug from "@lucide/svelte/icons/unplug";
    import X from "@lucide/svelte/icons/x";
    import { untrack } from "svelte";
    import { cubicOut, expoOut } from "svelte/easing";
    import { prefersReducedMotion } from "svelte/motion";
    import { fly } from "svelte/transition";
    import VolumeDialog from "../controls/volume-dialog.svelte";
    import CanvasConfigFile from "./canvas-config-file.svelte";
    import type {
        CanvasConfig,
        CanvasResource,
        CanvasService,
        VolumeTarget,
    } from "../graph";

    let {
        resource,
        config,
        services,
        width,
        inset,
        onclose,
        onremove,
    }: {
        resource: CanvasResource;
        config: CanvasConfig;
        services: CanvasService[];
        /** Pixel width, shared with the canvas so it can keep the opened node in view. */
        width: number;
        /** Narrow canvases hide the graph: the panel floats over all of it, inset from the sides. */
        inset: boolean;
        onclose: () => void;
        /** Asks to delete the config; the canvas confirms it first. */
        onremove: () => void;
    } = $props();

    let connecting = $state(false);

    let pending = $state(false);

    let error = $state("");

    // The panel is keyed by the selection, so this starts from the saved content of this config.
    let content = $state(untrack(() => config.content ?? ""));

    const dirty = $derived(
        config.content !== null && content !== config.content,
    );

    // Edited mount fields by `<service>:target` and `<service>:mode`; each shows what is saved until typed in.
    let typed = $state<Record<string, string>>({});

    const targets = $derived<VolumeTarget[]>(
        services.flatMap((service) =>
            config.services.includes(service.name)
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
        config: config.name,
    });

    function save() {
        void run(
            () =>
                client.resources.updateConfigContent({
                    ...edit,
                    content,
                }),
            "The config could not be saved.",
        );
    }

    async function connect(target: VolumeTarget, path: string) {
        const done = await run(
            () =>
                client.resources.attachConfig({
                    ...edit,
                    service: target.service,
                    target: path,
                }),
            "The config could not be connected.",
        );

        if (done) connecting = false;
    }

    async function remount(mount: CanvasConfig["mounts"][number]) {
        const target = (
            typed[`${mount.service}:target`] ?? mount.target
        ).trim();

        const mode = (
            typed[`${mount.service}:mode`] ??
            mount.mode ??
            ""
        ).trim();

        if (target === mount.target && mode === (mount.mode ?? ""))
            return;

        const done = await run(
            () =>
                client.resources.updateConfigMount({
                    ...edit,
                    service: mount.service,
                    target,
                    mode,
                }),
            "The mount could not be changed.",
        );

        if (done) {
            delete typed[`${mount.service}:target`];
            delete typed[`${mount.service}:mode`];
        }
    }

    function disconnect(service: string) {
        void run(
            () => client.resources.detachConfig({ ...edit, service }),
            "The config could not be disconnected.",
        );
    }

    function field(key: string, saved: string) {
        return {
            get value() {
                return typed[key] ?? saved;
            },
            set value(value: string) {
                typed[key] = value;
            },
        };
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
    aria-label="{config.name} config"
    in:fly|global={enter}
    out:fly|global={leave}
>
    <header class="flex items-center gap-4 px-12 pt-12 pb-6">
        <FileCog
            class="size-8 shrink-0"
            strokeWidth={1.5}
            aria-hidden="true"
        />
        <h2 class="min-w-0 flex-1 truncate text-2xl font-semibold">
            {config.name}
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

    <div
        class="min-h-0 flex-1 space-y-10 overflow-y-auto border-t border-border px-12 pt-8 pb-12"
    >
        {#if error}
            <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        {/if}
        <section class="space-y-4">
            {#if config.content !== null}
                <div class="flex items-center justify-between gap-4">
                    <h3 class="text-xl text-muted-foreground">
                        Content
                    </h3>
                    <Button
                        disabled={!dirty || pending}
                        loading={pending && dirty}
                        onclick={save}
                    >
                        Save
                    </Button>
                </div>
                <p class="text-sm text-muted-foreground">
                    <code>${"{VAR}"}</code>
                    reads Variables; write
                    <code>$$</code>
                    for a literal
                    <code>$</code>
                    .
                </p>
                <div class="overflow-hidden rounded-lg border">
                    <CodeEditor
                        bind:value={content}
                        language="text"
                        label="{config.name} content"
                        readOnly={pending}
                    />
                </div>
            {:else if resource.gitBranch && config.file}
                <CanvasConfigFile {resource} file={config.file} />
            {:else}
                <h3 class="text-xl text-muted-foreground">Content</h3>
                <Alert variant="warning">
                    <AlertDescription>
                        {#if config.file}
                            Reads <code>{config.file}</code>
                            . Stoat deploys relative config files only
                            from a Git source.
                        {:else}
                            Set from an environment variable; edit it
                            in the Compose file.
                        {/if}
                    </AlertDescription>
                </Alert>
            {/if}
        </section>
        <section class="space-y-4">
            <h3 class="text-xl text-muted-foreground">Connection</h3>
            {#each config.mounts as mount (mount.service)}
                {@const target = field(
                    `${mount.service}:target`,
                    mount.target,
                )}
                {@const mode = field(
                    `${mount.service}:mode`,
                    mount.mode ?? "",
                )}
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
                            bind:value={target.value}
                            onblur={() => void remount(mount)}
                            onkeydown={(event) => {
                                if (event.key === "Enter")
                                    event.currentTarget.blur();
                            }}
                        />
                        <Input
                            class="w-24 shrink-0 font-mono"
                            aria-label="File mode in {mount.service}"
                            placeholder="0444"
                            spellcheck={false}
                            maxlength={4}
                            disabled={pending}
                            bind:value={mode.value}
                            onblur={() => void remount(mount)}
                            onkeydown={(event) => {
                                if (event.key === "Enter")
                                    event.currentTarget.blur();
                            }}
                        />
                        <Button
                            variant="outline"
                            disabled={pending}
                            onclick={() => disconnect(mount.service)}
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
                Delete Config
            </h3>
            <Button
                variant="destructive"
                disabled={pending}
                onclick={onremove}
            >
                <Trash2 class="size-4" aria-hidden="true" />
                Delete Config
            </Button>
        </section>
    </div>
</aside>

{#if connecting}
    <VolumeDialog
        {targets}
        volume={config.name}
        placeholder="/etc/app.conf"
        {pending}
        {error}
        onsubmit={(target, path) => void connect(target, path)}
        onclose={() => (connecting = false)}
    />
{/if}
