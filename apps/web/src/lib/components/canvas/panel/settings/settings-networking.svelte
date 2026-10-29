<script lang="ts">
    import { orpc } from "$lib/api/orpc";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import Cable from "@lucide/svelte/icons/cable";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import Copy from "@lucide/svelte/icons/copy";
    import Globe from "@lucide/svelte/icons/globe";
    import Pencil from "@lucide/svelte/icons/pencil";
    import Plus from "@lucide/svelte/icons/plus";
    import Trash2 from "@lucide/svelte/icons/trash-2";
    import {
        parseIngressCompose,
        removeIngressFromCompose,
        removeServiceCaddy,
        type HostIngress,
        type HttpIngress,
        type IngressEntry,
    } from "@stoat/workflows/ingress";
    import { createQuery } from "@tanstack/svelte-query";
    import type { Component, Snippet } from "svelte";
    import type { CanvasResource, CanvasService } from "../../graph";
    import CanvasIngressDialog, {
        type IngressMode,
    } from "../canvas-ingress-dialog.svelte";
    import SettingsTitle from "./settings-title.svelte";

    let {
        resource,
        services,
        draftCompose,
        env,
        isInternal,
        savingDraft,
        saveDraft,
        shows,
    }: {
        resource: CanvasResource;
        services: CanvasService[];
        draftCompose: string;
        env: string;
        isInternal: boolean;
        savingDraft: boolean;
        /** Resolves to the error message, or null once saved. */
        saveDraft: (compose: string) => Promise<string | null>;
        shows: (...words: string[]) => boolean;
    } = $props();

    // Ingress is edited in the draft, like the Ingress page; the next deploy publishes it.
    const ingress = $derived.by(() => {
        try {
            return parseIngressCompose(draftCompose, env);
        } catch {
            return null;
        }
    });

    const ingressEntries = $derived(ingress?.entries ?? []);

    let ingressDialog = $state<{
        mode: IngressMode;
        entry: HttpIngress | HostIngress | null;
    } | null>(null);

    let ingressRemoval = $state<IngressEntry | null>(null);

    let ingressError = $state("");

    const canEditIngress = $derived(
        !isInternal && ingress !== null && !savingDraft,
    );

    async function removeIngress(entry: IngressEntry) {
        ingressError = "";

        try {
            ingressError =
                (await saveDraft(
                    entry.kind === "caddy"
                        ? removeServiceCaddy(
                              draftCompose,
                              entry.service,
                          )
                        : removeIngressFromCompose(
                              draftCompose,
                              entry.service,
                              entry.raw,
                          ),
                )) ?? "";
        } catch (cause) {
            ingressError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        }
    }

    // STOAT_DOMAIN and STOAT_PREFIX, to name the hostname Uncloud gives a hostless entry.
    const systemQuery = createQuery(() =>
        orpc.resources.listSystemVariables.queryOptions({
            input: {
                projectId: resource.projectId,
                resourceId: resource.id,
            },
        }),
    );

    const systemValue = (key: string) =>
        systemQuery.data?.find((variable) => variable.key === key)
            ?.value;

    // Uncloud publishes a hostless entry at `<prefixed service>.<cluster domain>`.
    function httpHostname(entry: HttpIngress) {
        if (entry.hostname) return entry.hostname;

        const domain = systemValue("STOAT_DOMAIN");
        const prefix = systemValue("STOAT_PREFIX");

        return domain
            ? `${prefix ? `${prefix}-` : ""}${entry.service}.${domain}`
            : undefined;
    }

    function ingressUrl(entry: IngressEntry) {
        if (entry.kind !== "http") return undefined;

        const hostname = httpHostname(entry);

        return hostname
            ? `${entry.protocol}://${hostname}`
            : undefined;
    }

    function ingressLabel(entry: IngressEntry) {
        if (entry.kind === "http")
            return httpHostname(entry) ?? "Cluster default domain";

        if (entry.kind === "host")
            return `${entry.bind ?? "*"}:${entry.hostPort}`;

        return "Custom Caddy";
    }

    const privateHosts = $derived(
        services.flatMap((service) =>
            service.internalHostname
                ? [
                      {
                          hostname: service.internalHostname,
                          service: service.name,
                      },
                  ]
                : [],
        ),
    );
</script>

<!-- Railway's networking row: icon, a name with a muted line beneath, actions on the right. -->
{#snippet networkRow(
    icon: Component,
    iconClass: string,
    name: string,
    href: string | undefined,
    detail: Snippet,
    copyText: string | undefined,
    entry: IngressEntry | null,
)}
    {@const Icon = icon}
    <div class="flex items-center gap-4 rounded-md border px-4 py-3">
        <Icon
            class={["size-5 shrink-0", iconClass]}
            aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
            {#if href}
                <a
                    {href}
                    target="_blank"
                    rel="noreferrer"
                    class="block truncate hover:underline"
                >
                    {name}
                </a>
            {:else}
                <p class="truncate">{name}</p>
            {/if}
            <p
                class="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground"
            >
                {@render detail()}
            </p>
        </div>
        <div class="flex shrink-0 items-center">
            {#if copyText}
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Copy {name}"
                    onclick={() =>
                        void navigator.clipboard.writeText(copyText)}
                >
                    <Copy class="size-4" aria-hidden="true" />
                </Button>
            {/if}
            {#if entry && !isInternal}
                {#if entry.kind === "caddy"}
                    <!-- A Caddyfile has no Railway form; the Ingress page edits it. -->
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit {name} on the Ingress page"
                        href="/projects/{resource.projectId}/{resource.id}/ingress"
                    >
                        <Pencil class="size-4" aria-hidden="true" />
                    </Button>
                {:else}
                    <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label="Edit {name}"
                        disabled={!canEditIngress}
                        onclick={() =>
                            (ingressDialog = {
                                mode:
                                    entry.kind === "http"
                                        ? "domain"
                                        : "tcp",
                                entry,
                            })}
                    >
                        <Pencil class="size-4" aria-hidden="true" />
                    </Button>
                {/if}
                <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Remove {name}"
                    disabled={!canEditIngress}
                    onclick={() => (ingressRemoval = entry)}
                >
                    <Trash2 class="size-4" aria-hidden="true" />
                </Button>
            {/if}
        </div>
    </div>
{/snippet}

{#if shows("networking", "public", "domain", "port")}
    <div>
        <SettingsTitle
            text={"Public Networking"}
            description={"Access your application over HTTP with the following domains."}
        />
        <div class="mt-3 space-y-2">
            {#each ingressEntries as entry (entry.kind === "caddy" ? `caddy/${entry.service}` : `${entry.service}/${entry.raw}`)}
                {@const url = ingressUrl(entry)}
                {#snippet detail()}
                    {#if entry.kind === "caddy"}
                        Caddyfile routes
                    {:else}
                        <ArrowRight
                            class="size-3 shrink-0"
                            aria-hidden="true"
                        />
                        Port {entry.containerPort}
                        {#if entry.kind === "host"}
                            · {entry.protocol.toUpperCase()}
                        {/if}
                    {/if}
                    {#if services.length > 1}
                        · {entry.service}
                    {/if}
                {/snippet}
                {@render networkRow(
                    entry.kind === "http" ? Globe : Cable,
                    "text-muted-foreground",
                    ingressLabel(entry),
                    url,
                    detail,
                    url ??
                        (entry.kind === "host"
                            ? ingressLabel(entry)
                            : undefined),
                    entry,
                )}
            {:else}
                <p
                    class="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
                >
                    {ingress === null
                        ? "The Compose draft is not valid YAML, so its ingress can't be read."
                        : "Nothing is public yet."}
                </p>
            {/each}
        </div>
        {#if ingressError}
            <Alert variant="error" class="mt-3">
                <AlertDescription>
                    {ingressError}
                </AlertDescription>
            </Alert>
        {/if}
        {#if !isInternal}
            <div class="mt-3 flex flex-wrap gap-2">
                <Button
                    variant="outline"
                    disabled={!canEditIngress}
                    onclick={() =>
                        (ingressDialog = {
                            mode: "domain",
                            entry: null,
                        })}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    Custom Domain
                </Button>
                <Button
                    variant="outline"
                    disabled={!canEditIngress}
                    onclick={() =>
                        (ingressDialog = {
                            mode: "tcp",
                            entry: null,
                        })}
                >
                    <Plus class="size-4" aria-hidden="true" />
                    TCP Proxy
                </Button>
            </div>
        {/if}
    </div>
{/if}

{#if shows("networking", "private", "internal", "dns")}
    <div>
        <SettingsTitle
            text={"Private Networking"}
            description={"Communicate with this service from anywhere in the cluster."}
        />
        <div class="mt-3 space-y-2">
            {#each privateHosts as entry (entry.hostname)}
                {#snippet detail()}
                    Ready to talk privately
                    {#if services.length > 1}
                        <span>· {entry.service}</span>
                    {/if}
                {/snippet}
                {@render networkRow(
                    CircleCheck,
                    "text-success-foreground",
                    entry.hostname,
                    undefined,
                    detail,
                    entry.hostname,
                    null,
                )}
            {:else}
                <p
                    class="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground"
                >
                    Private hostnames appear after the first deploy.
                </p>
            {/each}
        </div>
    </div>
{/if}

{#if ingressDialog}
    <CanvasIngressDialog
        mode={ingressDialog.mode}
        entry={ingressDialog.entry}
        entries={ingressEntries}
        services={ingress?.services ?? []}
        compose={draftCompose}
        busy={savingDraft}
        onsubmit={(compose) => {
            ingressError = "";

            return saveDraft(compose);
        }}
        onclose={() => (ingressDialog = null)}
    />
{/if}

<ConfirmDialog
    bind:open={
        () => ingressRemoval !== null,
        (open) => {
            if (!open) ingressRemoval = null;
        }
    }
    title="Remove {ingressRemoval
        ? ingressLabel(ingressRemoval)
        : 'ingress'}?"
    description="It is removed from the Compose draft and stops being published on the next deploy."
    confirmLabel="Remove"
    onconfirm={() => {
        if (ingressRemoval) void removeIngress(ingressRemoval);
        ingressRemoval = null;
    }}
/>
