<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { page } from "$app/state";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { isActiveDeploymentStatus } from "$lib/deployments/status";
    import { ago, deploymentDuration } from "$lib/format";
    import { containerInfo } from "$lib/resources/container-info";
    import { imageIcon } from "$lib/resources/image-icons";
    import Box from "@lucide/svelte/icons/box";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";
    import CircleCheck from "@lucide/svelte/icons/circle-check";
    import CircleX from "@lucide/svelte/icons/circle-x";
    import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
    import EyeOff from "@lucide/svelte/icons/eye-off";
    import Globe from "@lucide/svelte/icons/globe";
    import Layers from "@lucide/svelte/icons/layers";
    import LoaderCircle from "@lucide/svelte/icons/loader-circle";
    import Server from "@lucide/svelte/icons/server";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryState,
    } from "nuqs-svelte";
    import { parse } from "yaml";
    import { z } from "zod";
    import { getCanvasClock } from "../context";
    import type { CanvasResource, CanvasService } from "../graph";

    let {
        clusterId,
        resource,
        services,
        selectedService,
        icon,
        changed,
    }: {
        clusterId: string;
        resource: CanvasResource;
        services: CanvasService[];
        selectedService: string | undefined;
        icon: string | null;
        /** Staged edits make "Redeploy" ship them, so it is only offered without any. */
        changed: boolean;
    } = $props();

    const clock = getCanvasClock();

    const urlOptions = { shallow: true, scroll: false } as const;

    // The deployment whose logs are stacked on top of the panel.
    const logs = useQueryState(
        "deployment",
        parseAsString.withOptions({ ...urlOptions, history: "push" }),
    );

    // Railway's expanded active deployment and folded history, kept in the URL like the tab.
    const expanded = useQueryState(
        "details",
        parseAsBoolean.withDefault(false).withOptions(urlOptions),
    );

    const historyHidden = useQueryState(
        "hideHistory",
        parseAsBoolean.withDefault(false).withOptions(urlOptions),
    );

    const deploymentsQuery = createQuery(() =>
        orpc.cluster.listAllDeployments.queryOptions({
            input: { resourceId: resource.id, limit: 20 },
        }),
    );

    const containersQuery = createQuery(() =>
        orpc.resources.getContainers.queryOptions({
            input: {
                clusterId,
                projectId: resource.projectId,
                resourceId: resource.id,
            },
            enabled: clusterId.length > 0 && services.length > 0,
        }),
    );

    type Deployment = NonNullable<
        typeof deploymentsQuery.data
    >["items"][number];

    const items = $derived(deploymentsQuery.data?.items ?? []);

    // The live deployment is the newest that finished, not simply the newest: a later failure leaves it running.
    const live = $derived(
        items.find((item) => item.status === "ready"),
    );

    // Like Railway: the live deployment, with anything still rolling out above it.
    const current = $derived.by(() => {
        const liveIndex = live ? items.indexOf(live) : items.length;

        const rolling = items
            .slice(0, liveIndex)
            .filter((item) => isActiveDeploymentStatus(item.status));

        if (live) return [...rolling, live];

        return rolling.length ? rolling : items.slice(0, 1);
    });

    const history = $derived(
        items.filter((item) => !current.includes(item)),
    );

    const isAdmin = $derived(page.data.isOrganizationAdmin === true);

    const domains = $derived(
        services
            .filter(
                (service) =>
                    !selectedService ||
                    service.name === selectedService,
            )
            .flatMap((service) => service.domains),
    );

    const containers = $derived(containersQuery.data ?? []);

    const sources = {
        forgejo: "Forgejo",
        github: "GitHub",
        git: "Git",
        docker: "Docker",
    };

    // Deployments from before metadata existed fall back to the resource's current source.
    function via(deployment: Deployment) {
        const source =
            deployment.metadata?.source ??
            (resource.gitBranch ? "git" : "docker");

        return sources[source];
    }

    type Tone = "success" | "info" | "error" | "neutral";

    // Railway's badge words; superseded deployments are "Removed".
    function badge(deployment: Deployment) {
        if (deployment === live) return "Active";

        if (isActiveDeploymentStatus(deployment.status))
            return deployment.status === "queued"
                ? "Queued"
                : "Deploying";

        if (deployment.status === "failed") return "Failed";

        if (deployment.status === "cancelled") return "Cancelled";

        return "Removed";
    }

    function tone(deployment: Deployment): Tone {
        if (deployment === live) return "success";

        if (isActiveDeploymentStatus(deployment.status))
            return "info";

        if (deployment.status === "failed") return "error";

        return "neutral";
    }

    const tones: Record<
        Tone,
        { card: string; row: string; badge: string; text: string }
    > = {
        success: {
            card: "border-success/24",
            row: "bg-success/6",
            badge: "bg-success/16 text-success-foreground",
            text: "text-success-foreground",
        },
        info: {
            card: "border-info/24",
            row: "bg-info/6",
            badge: "bg-info/16 text-info-foreground",
            text: "text-info-foreground",
        },
        error: {
            card: "border-destructive/24",
            row: "bg-destructive/6",
            badge: "bg-destructive/16 text-destructive-foreground",
            text: "text-destructive-foreground",
        },
        neutral: {
            card: "border-border",
            row: "bg-muted/40",
            badge: "bg-muted text-muted-foreground",
            text: "text-muted-foreground",
        },
    };

    const composeSchema = z
        .object({
            services: z
                .record(
                    z.string(),
                    z
                        .object({ image: z.string().optional() })
                        .catch({}),
                )
                .catch({}),
        })
        .catch({ services: {} });

    // The images a deployment shipped, from its Compose snapshot; the selected service's comes first.
    function images(spec: string | null) {
        let services: Record<string, { image?: string }> = {};

        try {
            services = composeSchema.parse(
                parse(spec ?? ""),
            ).services;
        } catch {
            // An unreadable snapshot just falls back to the resource name.
        }

        const selected = selectedService
            ? services[selectedService]?.image
            : undefined;

        const all = Object.values(services).flatMap(
            (service) => service.image ?? [],
        );

        return [...new Set(selected ? [selected, ...all] : all)];
    }

    // Railway titles a Git deploy by its commit and a Docker deploy by its image; with a service
    // open, only that one counts.
    function title(deployment: Deployment) {
        const message =
            deployment.metadata?.commit?.message.split("\n")[0];

        if (message) return message;

        const [first, ...rest] = images(deployment.spec);

        if (!first) return resource.name;

        return rest.length && !selectedService
            ? `${first} + ${rest.length} more`
            : first;
    }

    function avatar(deployment: Deployment) {
        return icon ?? imageIcon(images(deployment.spec)[0]);
    }

    let pending = $state<"redeploy" | "cancel" | "remove">();

    let actionError = $state("");

    let removing = $state<Deployment>();

    async function run(
        action: "redeploy" | "cancel" | "remove",
        work: () => Promise<object>,
    ) {
        pending = action;
        actionError = "";

        try {
            await work();
            await queryClient.invalidateQueries({
                queryKey: orpc.cluster.listAllDeployments.key(),
            });
            await queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.key(),
            });
            removing = undefined;
        } catch (cause) {
            actionError =
                cause instanceof Error
                    ? cause.message
                    : "Something went wrong.";
        } finally {
            pending = undefined;
        }
    }

    const redeploy = () =>
        run("redeploy", () =>
            client.resources.deploy({
                projectId: resource.projectId,
                resourceId: resource.id,
                recreate: true,
            }),
        );

    const cancel = (deployment: Deployment) =>
        run("cancel", () =>
            client.cluster.cancelDeployment({
                deploymentId: deployment.id,
            }),
        );
</script>

{#snippet card(deployment: Deployment, main: boolean)}
    {@const style = tones[tone(deployment)]}
    <!-- History stays neutral, as in Railway; only its badge carries the outcome. -->
    {@const surface = main ? style : tones.neutral}
    {@const logo = avatar(deployment)}
    {@const isLive = deployment === live}
    {@const rolling = isActiveDeploymentStatus(deployment.status)}
    <!-- Railway's deployment card: a tinted 1px frame around rows inset by 4px. -->
    <article
        class={["rounded-lg border p-1", surface.card]}
        aria-label="{badge(deployment)} deployment"
    >
        <div
            class={[
                "relative grid grid-cols-[84px_24px_minmax(0,1fr)_auto] items-center gap-x-4 rounded-md px-3 py-4",
                surface.row,
            ]}
        >
            <span
                class={[
                    "justify-self-start rounded-md px-2 py-1 text-xs font-medium uppercase",
                    style.badge,
                ]}
            >
                {badge(deployment)}
            </span>
            {#if logo}
                <img
                    src={logo}
                    alt=""
                    aria-hidden="true"
                    class="size-6 object-contain"
                />
            {:else}
                <Box
                    class="size-6 text-muted-foreground"
                    strokeWidth={1.5}
                    aria-hidden="true"
                />
            {/if}
            <!-- Its hit area stretches over the whole row, so clicking anywhere opens the logs. -->
            <button
                type="button"
                class="min-w-0 text-left outline-none after:absolute after:inset-0 after:rounded-md after:transition-colors hover:after:bg-foreground/4 focus-visible:after:ring-2 focus-visible:after:ring-ring"
                onclick={() => void logs.set(deployment.id)}
            >
                <p class="truncate text-sm" title={title(deployment)}>
                    {title(deployment)}
                </p>
                <p class="truncate text-sm text-muted-foreground">
                    {ago(deployment.createdAt, clock.now)} via {via(
                        deployment,
                    )}
                    {#if deployment.metadata?.commit}
                        · <span class="font-mono">
                            {deployment.metadata.commit.sha.slice(
                                0,
                                7,
                            )}
                        </span>
                    {/if}
                </p>
            </button>
            <div class="relative z-10">
                <Menu>
                    <MenuTrigger
                        class="flex size-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent"
                        aria-label="Deployment actions"
                    >
                        <EllipsisVertical
                            class="size-4"
                            aria-hidden="true"
                        />
                    </MenuTrigger>
                    <MenuPopup align="end" class="min-w-48">
                        <MenuItem
                            onclick={() =>
                                void logs.set(deployment.id)}
                        >
                            View logs
                        </MenuItem>
                        {#if isLive && isAdmin && !changed}
                            <MenuItem
                                disabled={pending !== undefined}
                                onclick={redeploy}
                            >
                                Redeploy
                            </MenuItem>
                        {/if}
                        {#if rolling && isAdmin}
                            <MenuItem
                                disabled={pending !== undefined}
                                onclick={() => cancel(deployment)}
                            >
                                Cancel
                            </MenuItem>
                        {/if}
                        {#if !main && deploymentsQuery.data?.canDelete}
                            <MenuItem
                                variant="destructive"
                                onclick={() =>
                                    (removing = deployment)}
                            >
                                Remove
                            </MenuItem>
                        {/if}
                    </MenuPopup>
                </Menu>
            </div>
        </div>

        {#if main}
            <!-- Railway's status row; on the live deployment it opens what is running. -->
            <button
                type="button"
                class={[
                    "mt-px flex w-full items-center gap-4 rounded-md py-2 pr-3 pl-[96px] text-left text-sm",
                    style.row,
                    style.text,
                ]}
                aria-expanded={isLive ? expanded.current : undefined}
                disabled={!isLive}
                onclick={() =>
                    void expanded.set(!expanded.current || null)}
            >
                {#if rolling}
                    <LoaderCircle
                        class="size-4 shrink-0 animate-spin"
                        aria-hidden="true"
                    />
                {:else if deployment.status === "failed"}
                    <CircleX
                        class="size-4 shrink-0"
                        aria-hidden="true"
                    />
                {:else}
                    <CircleCheck
                        class="size-4 shrink-0"
                        aria-hidden="true"
                    />
                {/if}
                <span class="min-w-0 flex-1 truncate">
                    {#if rolling}
                        Deployment in progress
                    {:else if deployment.status === "failed"}
                        Deployment failed
                    {:else if deployment.status === "cancelled"}
                        Deployment cancelled
                    {:else}
                        Deployment successful
                    {/if}
                    <span class="text-muted-foreground tabular-nums">
                        ({deploymentDuration(
                            deployment.createdAt,
                            deployment.finishedAt,
                            clock.now,
                        )})
                    </span>
                </span>
                {#if isLive}
                    <ChevronDown
                        class={[
                            "size-4 shrink-0 text-foreground transition-transform",
                            expanded.current && "rotate-180",
                        ]}
                        aria-hidden="true"
                    />
                {/if}
            </button>

            {#if isLive && expanded.current}
                <!-- Railway lists build steps here; Stoat shows the containers this deployment runs. -->
                <ul class="py-1">
                    {#if containersQuery.isPending}
                        <li>
                            <Skeleton
                                loading
                                count={2}
                                loading-label="Loading containers"
                            >
                                <div
                                    class="grid grid-cols-[16px_1fr_auto] gap-4 py-3 pr-3 pl-[96px] text-sm"
                                >
                                    <span>.</span>
                                    <span>container-name</span>
                                    <span>healthy</span>
                                </div>
                            </Skeleton>
                        </li>
                    {:else if containersQuery.isError}
                        <li
                            class="py-3 pr-3 pl-[96px] text-sm text-destructive-foreground"
                        >
                            Unable to load containers: {containersQuery
                                .error.message}
                        </li>
                    {:else}
                        {#each containers as item, index (`${item.machineId}-${item.container.Id ?? index}`)}
                            {@const info = containerInfo(
                                item.container,
                            )}
                            <li
                                class="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-4 py-3 pr-3 pl-[96px] text-sm"
                            >
                                {#if info.health === "unhealthy" || info.status === "exited"}
                                    <CircleX
                                        class="size-4 text-destructive-foreground"
                                        aria-hidden="true"
                                    />
                                {:else}
                                    <CircleCheck
                                        class="size-4 text-success-foreground"
                                        aria-hidden="true"
                                    />
                                {/if}
                                <span
                                    class="min-w-0 truncate"
                                    title={info.image}
                                >
                                    {info.name}
                                    <span
                                        class="text-muted-foreground"
                                    >
                                        · {item.machineName ||
                                            item.machineId}
                                    </span>
                                </span>
                                <span
                                    class="text-muted-foreground capitalize"
                                >
                                    {info.health === "Unknown"
                                        ? info.status
                                        : info.health}
                                </span>
                            </li>
                        {:else}
                            <li
                                class="py-3 pr-3 pl-[96px] text-sm text-muted-foreground"
                            >
                                No containers are running.
                            </li>
                        {/each}
                    {/if}
                </ul>
            {/if}
        {/if}
    </article>
{/snippet}

<div class="space-y-4">
    <!-- Railway's meta line: the public domain on the left, region and replicas on the right. -->
    <div class="flex items-center gap-4 text-sm">
        {#if domains.length}
            <a
                href="https://{domains[0]}"
                target="_blank"
                rel="noreferrer"
                class="flex min-w-0 items-center gap-2 hover:underline"
            >
                <Globe
                    class="size-4 shrink-0 text-success-foreground"
                    aria-hidden="true"
                />
                <span class="truncate">{domains[0]}</span>
                {#if domains.length > 1}
                    <span class="text-muted-foreground">
                        + {domains.length - 1} more
                    </span>
                {/if}
            </a>
        {:else}
            <span
                class="flex items-center gap-2 text-muted-foreground"
            >
                <EyeOff class="size-4" aria-hidden="true" />
                Unexposed service
            </span>
        {/if}
        <span
            class="ml-auto flex shrink-0 items-center gap-6 text-muted-foreground"
        >
            {#if items[0]}
                <span class="flex items-center gap-2">
                    <Server class="size-4" aria-hidden="true" />
                    {items[0].clusterName}
                </span>
            {/if}
            {#if containersQuery.data}
                <span class="flex items-center gap-2">
                    <Layers class="size-4" aria-hidden="true" />
                    {containers.length}
                    {containers.length === 1
                        ? "Container"
                        : "Containers"}
                </span>
            {/if}
        </span>
    </div>

    {#if actionError}
        <Alert variant="error">
            <AlertDescription>{actionError}</AlertDescription>
        </Alert>
    {/if}

    {#if deploymentsQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load deployments: {deploymentsQuery.error
                    .message}
            </AlertDescription>
        </Alert>
    {:else if deploymentsQuery.isPending}
        <Skeleton loading loading-label="Loading deployments">
            <div class="h-[126px] rounded-lg border"></div>
        </Skeleton>
    {:else if !items.length}
        <p
            class="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground"
        >
            No deployments yet. Deploy this resource to see it here.
        </p>
    {:else}
        {#each current as deployment (deployment.id)}
            {@render card(deployment, true)}
        {/each}

        {#if history.length}
            <section
                class="space-y-4"
                aria-label="Deployment history"
            >
                <button
                    type="button"
                    class="flex items-center gap-2 text-xs font-medium uppercase"
                    aria-expanded={!historyHidden.current}
                    onclick={() =>
                        void historyHidden.set(
                            !historyHidden.current || null,
                        )}
                >
                    <ChevronDown
                        class={[
                            "size-4 transition-transform",
                            historyHidden.current && "-rotate-90",
                        ]}
                        aria-hidden="true"
                    />
                    History
                </button>
                {#if !historyHidden.current}
                    {#each history as deployment (deployment.id)}
                        {@render card(deployment, false)}
                    {/each}
                {/if}
            </section>
        {/if}
    {/if}
</div>

{#if removing}
    {@const target = removing}
    <ConfirmDialog
        bind:open={
            () => removing !== undefined,
            (open) => {
                if (!open) removing = undefined;
            }
        }
        title="Remove deployment"
        description="This deletes the deployment and its logs from Stoat. Running containers are not affected."
        confirmLabel="Remove"
        pending={pending === "remove"}
        error={actionError}
        onconfirm={() =>
            void run("remove", () =>
                client.cluster.deleteDeployment({
                    deploymentId: target.id,
                }),
            )}
    />
{/if}
