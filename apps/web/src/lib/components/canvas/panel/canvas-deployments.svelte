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
    import { Badge } from "$lib/components/ui/badge";
    import { FramePanel } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { page } from "$app/state";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { isActiveDeploymentStatus } from "$lib/deployments/status";
    import { ago, deploymentDuration } from "$lib/format";
    import {
        allExited,
        containerInfo,
    } from "$lib/resources/container-info";
    import { imageIcon } from "$lib/resources/image-icons";
    import Box from "phosphor-svelte/lib/CubeIcon";
    import ChevronDown from "phosphor-svelte/lib/CaretDownIcon";
    import CircleCheck from "phosphor-svelte/lib/CheckCircleIcon";
    import CircleX from "phosphor-svelte/lib/XCircleIcon";
    import EllipsisVertical from "phosphor-svelte/lib/DotsThreeVerticalIcon";
    import EyeOff from "phosphor-svelte/lib/EyeSlashIcon";
    import Globe from "phosphor-svelte/lib/GlobeIcon";
    import Layers from "phosphor-svelte/lib/StackIcon";
    import LoaderCircle from "phosphor-svelte/lib/CircleNotchIcon";
    import Server from "phosphor-svelte/lib/HardDrivesIcon";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        parseAsBoolean,
        parseAsString,
        useQueryState,
    } from "nuqs-svelte";
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

    // Stopped from the canvas: the deployment is still the live one, but nothing runs.
    const stopped = $derived(allExited(containers));

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

    type Tone = "success" | "info" | "error" | "secondary";

    // Railway's badge words; superseded deployments are "Removed".
    function badge(deployment: Deployment) {
        if (deployment === live)
            return stopped ? "Stopped" : "Active";

        if (isActiveDeploymentStatus(deployment.status))
            return deployment.status === "queued"
                ? "Queued"
                : "Deploying";

        if (deployment.status === "failed") return "Failed";

        if (deployment.status === "cancelled") return "Cancelled";

        return "Removed";
    }

    function tone(deployment: Deployment): Tone {
        if (deployment === live)
            return stopped ? "secondary" : "success";

        if (isActiveDeploymentStatus(deployment.status))
            return "info";

        if (deployment.status === "failed") return "error";

        return "secondary";
    }

    // Each tone doubles as a Badge variant; this is the matching status-row text.
    const toneText: Record<Tone, string> = {
        success: "text-success-foreground",
        info: "text-info-foreground",
        error: "text-destructive-foreground",
        secondary: "text-muted-foreground",
    };

    // The images a deployment shipped, resolved with its Variables; the selected service's comes first.
    function images(deployment: Deployment) {
        const selected = selectedService
            ? deployment.images[selectedService]
            : undefined;

        const all = Object.values(deployment.images);

        return [...new Set(selected ? [selected, ...all] : all)];
    }

    // Railway titles a Git deploy by its commit and a Docker deploy by its image; with a service
    // open, only that one counts.
    function title(deployment: Deployment) {
        const message =
            deployment.metadata?.commit?.message.split("\n")[0];

        if (message) return message;

        const [first, ...rest] = images(deployment);

        if (!first) return resource.name;

        return rest.length && !selectedService
            ? `${first} + ${rest.length} more`
            : first;
    }

    function avatar(deployment: Deployment) {
        return icon ?? imageIcon(images(deployment)[0]);
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

{#snippet logoImage(deployment: Deployment)}
    {@const logo = avatar(deployment)}
    <!-- The list recipe's 40px muted well. -->
    <span
        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted"
    >
        {#if logo}
            <img
                src={logo}
                alt=""
                aria-hidden="true"
                class="size-5 object-contain"
            />
        {:else}
            <Box
                class="size-5 text-muted-foreground"
                weight="regular"
                aria-hidden="true"
            />
        {/if}
    </span>
{/snippet}

{#snippet actions(deployment: Deployment, main: boolean)}
    <div class="relative z-10">
        <Menu>
            <MenuTrigger
                class="flex size-8 items-center justify-center rounded-md text-foreground transition-colors hover:bg-accent"
                aria-label="Deployment actions"
            >
                <EllipsisVertical class="size-4" aria-hidden="true" />
            </MenuTrigger>
            <MenuPopup align="end" class="min-w-48">
                <MenuItem
                    onclick={() => void logs.set(deployment.id)}
                >
                    View logs
                </MenuItem>
                {#if deployment === live && !changed}
                    <MenuItem
                        disabled={pending !== undefined}
                        onclick={redeploy}
                    >
                        Redeploy
                    </MenuItem>
                {/if}
                {#if isActiveDeploymentStatus(deployment.status)}
                    <MenuItem
                        disabled={pending !== undefined}
                        onclick={() => cancel(deployment)}
                    >
                        Cancel
                    </MenuItem>
                {/if}
                {#if !main}
                    <MenuItem
                        variant="destructive"
                        onclick={() => (removing = deployment)}
                    >
                        Remove
                    </MenuItem>
                {/if}
            </MenuPopup>
        </Menu>
    </div>
{/snippet}

<!-- Clicking anywhere on a row opens its logs: the button's hit area stretches over the row. -->
{#snippet logsButton(deployment: Deployment)}
    <button
        type="button"
        class="absolute inset-0 rounded-[inherit] outline-none transition-colors hover:bg-foreground/4 focus-visible:ring-2 focus-visible:ring-ring"
        aria-label="View logs for {title(deployment)}"
        onclick={() => void logs.set(deployment.id)}
    ></button>
{/snippet}

<!-- One deployment's row, shared by the current cards and the history list. -->
{#snippet summary(deployment: Deployment, main: boolean)}
    {@const variant = tone(deployment)}
    {@render logsButton(deployment)}
    {@render logoImage(deployment)}
    <div class="min-w-0 flex-1">
        <p
            class="truncate text-sm font-medium"
            title={title(deployment)}
        >
            {title(deployment)}
        </p>
        <p class="truncate text-xs text-muted-foreground">
            {ago(deployment.createdAt, clock.now)} via {via(
                deployment,
            )}
            {#if deployment.metadata?.commit}
                · <span class="font-mono">
                    {deployment.metadata.commit.sha.slice(0, 7)}
                </span>
            {/if}
        </p>
    </div>
    <Badge
        {variant}
        class={[variant === "secondary" && "text-muted-foreground"]}
    >
        {badge(deployment)}
    </Badge>
    {@render actions(deployment, main)}
{/snippet}

{#snippet currentCard(deployment: Deployment)}
    {@const variant = tone(deployment)}
    {@const isLive = deployment === live}
    {@const rolling = isActiveDeploymentStatus(deployment.status)}
    <section aria-label="{badge(deployment)} deployment">
        <div class="relative flex items-center gap-3 px-4 py-3">
            {@render summary(deployment, true)}
        </div>

        <!-- On the live deployment the status row opens what is running. -->
        <button
            type="button"
            class={[
                "flex w-full items-center gap-3 pt-0.5 pb-3 pr-4 pl-[68px] text-left text-sm",
                toneText[variant],
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
                <CircleX class="size-4 shrink-0" aria-hidden="true" />
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
                    {deploymentDuration(
                        deployment.createdAt,
                        deployment.finishedAt,
                        clock.now,
                    )}
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
            <!-- The containers this deployment runs. -->
            <ul class="pb-1.5">
                {#if containersQuery.isPending}
                    <li>
                        <Skeleton
                            loading
                            count={2}
                            label="Loading containers"
                        >
                            <div
                                class="grid grid-cols-[16px_1fr_auto] gap-3 pr-4 pb-2 pl-[68px] text-sm"
                            >
                                <span>.</span>
                                <span>container-name</span>
                                <span>healthy</span>
                            </div>
                        </Skeleton>
                    </li>
                {:else if containersQuery.isError}
                    <li
                        class="pr-4 pb-2 pl-[68px] text-sm text-destructive-foreground"
                    >
                        Unable to load containers: {containersQuery
                            .error.message}
                    </li>
                {:else}
                    {#each containers as item, index (`${item.machineId}-${item.container.Id ?? index}`)}
                        {@const info = containerInfo(item.container)}
                        <li
                            class="grid grid-cols-[16px_minmax(0,1fr)_auto] items-center gap-3 pr-4 pb-2 pl-[68px] text-sm"
                        >
                            {#if info.health === "unhealthy" || info.status === "exited"}
                                <CircleX
                                    class={[
                                        "size-4",
                                        stopped
                                            ? "text-muted-foreground"
                                            : "text-destructive-foreground",
                                    ]}
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
                                <span class="text-muted-foreground">
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
                            class="pr-4 pb-2 pl-[68px] text-sm text-muted-foreground"
                        >
                            No containers are running.
                        </li>
                    {/each}
                {/if}
            </ul>
        {/if}
    </section>
{/snippet}

<!-- Two panels on the side panel's surround, like Files and Tables: what is running, then history. -->
<div class="flex flex-col gap-1">
    <FramePanel class="divide-y bg-card p-0">
        <!-- Railway's meta line: the public domain on the left, region and replicas on the right. -->
        <div class="flex items-center gap-4 px-4 py-3 text-sm">
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
            <div class="px-4 py-3">
                <Alert variant="error">
                    <AlertDescription>{actionError}</AlertDescription>
                </Alert>
            </div>
        {/if}

        {#if deploymentsQuery.isError}
            <div class="px-4 py-3">
                <Alert variant="error">
                    <AlertDescription>
                        Unable to load deployments: {deploymentsQuery
                            .error.message}
                    </AlertDescription>
                </Alert>
            </div>
        {:else if deploymentsQuery.isPending}
            <div class="px-4 py-3">
                <Skeleton loading label="Loading deployments">
                    <div class="h-[88px] rounded-lg"></div>
                </Skeleton>
            </div>
        {:else if !items.length}
            <p
                class="px-4 py-12 text-center text-sm text-muted-foreground"
            >
                No deployments yet. Deploy this resource to see it
                here.
            </p>
        {:else}
            {#each current as deployment (deployment.id)}
                {@render currentCard(deployment)}
            {/each}
        {/if}
    </FramePanel>

    {#if deploymentsQuery.isSuccess && history.length}
        <FramePanel
            class="overflow-hidden bg-card p-0"
            aria-label="Deployment history"
        >
            <button
                type="button"
                class="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium"
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
                <span
                    class="ml-auto text-xs font-normal text-muted-foreground tabular-nums"
                >
                    {history.length}
                </span>
            </button>
            {#if !historyHidden.current}
                <ul class="divide-y border-t">
                    {#each history as deployment (deployment.id)}
                        <li
                            class="relative flex items-center gap-3 px-4 py-3"
                        >
                            {@render summary(deployment, false)}
                        </li>
                    {/each}
                </ul>
            {/if}
        </FramePanel>
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
        description="This deletes the deployment and its logs from Clowder. Running containers are not affected."
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
