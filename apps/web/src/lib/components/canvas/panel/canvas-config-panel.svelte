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
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";
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

    const tabs = ["content", "settings"] as const;

    const labels = { content: "Content", settings: "Settings" };

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

    // The panel is keyed by the selection, so this starts from the saved content of this config.
    let content = $state(untrack(() => config.content ?? ""));

    const dirty = $derived(
        config.content !== null && content !== config.content,
    );

    // When the saved content changes under the editor (a discard, another tab), follow it unless
    // there is unsaved typing.
    let seen = untrack(() => config.content ?? "");

    $effect(() => {
        const saved = config.content ?? "";

        untrack(() => {
            if (content === seen) content = saved;
            seen = saved;
        });
    });

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

    <!-- Railway's tabs, as in the resource and volume panels. -->
    <div
        class="flex shrink-0 gap-8 border-b border-border px-12"
        role="tablist"
        aria-label="{config.name} sections"
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

    {#if error}
        <Alert
            variant="error"
            class="rounded-none border-x-0 border-t-0"
        >
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}

    <!-- Hidden rather than unmounted, so switching tabs keeps unsaved typing. -->
    <div
        class="flex min-h-0 flex-1 flex-col overflow-hidden"
        role="tabpanel"
        hidden={active !== "content"}
    >
        {#if config.content !== null}
            <div
                class="flex h-10 shrink-0 items-center gap-3 border-b pr-2 pl-6 text-xs font-medium"
            >
                <p
                    class="min-w-0 flex-1 truncate text-muted-foreground"
                >
                    <code>${"{VAR}"}</code>
                    reads Variables,
                    <code>$$</code>
                    is a literal
                    <code>$</code>
                </p>
                <Button
                    size="xs"
                    disabled={!dirty || pending}
                    loading={pending && dirty}
                    onclick={save}
                >
                    Save
                </Button>
            </div>
            <div class="min-h-0 flex-1">
                <CodeEditor
                    bind:value={content}
                    language="text"
                    label="{config.name} content"
                    readOnly={pending}
                    fill
                />
            </div>
        {:else if resource.gitBranch && config.file}
            <CanvasConfigFile {resource} file={config.file} />
        {:else}
            <div class="px-12 pt-8">
                <Alert variant="warning">
                    <AlertDescription>
                        {#if config.file}
                            Reads <code>{config.file}</code>
                            . Stoat deploys relative config files only from
                            a Git source.
                        {:else}
                            Set from an environment variable; edit it
                            in the Compose file.
                        {/if}
                    </AlertDescription>
                </Alert>
            </div>
        {/if}
    </div>

    {#if active === "settings"}
        <div
            class="min-h-0 flex-1 space-y-8 overflow-y-auto px-12 pt-8 pb-12"
            role="tabpanel"
        >
            {#each config.mounts as mount (mount.service)}
                {@const target = field(
                    `${mount.service}:target`,
                    mount.target,
                )}
                {@const mode = field(
                    `${mount.service}:mode`,
                    mount.mode ?? "",
                )}
                <div>
                    <h4 class="text-sm font-semibold">
                        Mount path
                        {#if services.length > 1}
                            <span
                                class="font-normal text-muted-foreground"
                            >
                                · {mount.service}
                            </span>
                        {/if}
                    </h4>
                    <div class="mt-3 flex gap-2">
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
            {:else}
                <p
                    class="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
                >
                    Not connected to a service.
                </p>
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
            <div>
                <h4
                    class="text-sm font-medium text-destructive-foreground"
                >
                    Delete config
                </h4>
                <Button
                    variant="destructive"
                    class="mt-4"
                    disabled={pending}
                    onclick={onremove}
                >
                    <Trash2 class="size-4" aria-hidden="true" />
                    Delete config
                </Button>
            </div>
        </div>
    {/if}
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
