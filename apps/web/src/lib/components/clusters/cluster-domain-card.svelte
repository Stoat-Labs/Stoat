<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import CircleAlert from "phosphor-svelte/lib/WarningCircleIcon";
    import TrashSimple from "phosphor-svelte/lib/TrashSimpleIcon";
    import { createQuery } from "@tanstack/svelte-query";

    let {
        clusterId,
        onopendialog,
    }: {
        clusterId: string;
        onopendialog: (dialog: "domain" | "remove-domain") => void;
    } = $props();

    const domainQuery = createQuery(() =>
        orpc.cluster.getDomain.queryOptions({ input: { clusterId } }),
    );

    const current = $derived(domainQuery.data);
</script>

<Frame class="min-w-0">
    <FrameHeader
        class="flex-row items-center justify-between gap-2 px-2.5 py-3"
    >
        <div class="flex min-w-0 items-center gap-2">
            <FrameTitle>Domain</FrameTitle>
            {#if current}
                <Badge
                    variant={current.domain ? "success" : "secondary"}
                >
                    {current.domain ? "Set" : "Not set"}
                </Badge>
            {/if}
        </div>
        {#if current?.canManage}
            <div class="flex shrink-0 items-center gap-1">
                {#if current.domain}
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Remove domain"
                        onclick={() => onopendialog("remove-domain")}
                    >
                        <TrashSimple aria-hidden="true" />
                    </Button>
                {/if}
                <Button
                    variant="outline"
                    size="sm"
                    onclick={() => onopendialog("domain")}
                >
                    {current.domain ? "Change" : "Set domain"}
                </Button>
            </div>
        {/if}
    </FrameHeader>
    <FramePanel class="flex-1 p-0">
        {#if domainQuery.isPending}
            <Skeleton loading label="Loading the cluster domain">
                <p class="flex h-11 items-center px-4 text-sm">
                    Domain x9tx94.uncld.dev
                </p>
            </Skeleton>
        {:else if domainQuery.isError}
            <div class="p-4">
                <Alert variant="error">
                    <CircleAlert aria-hidden="true" />
                    <AlertDescription>
                        Unable to load the cluster domain: {domainQuery
                            .error.message}
                    </AlertDescription>
                </Alert>
            </div>
        {:else if current}
            <dl class="divide-y text-sm">
                <div
                    class="flex h-11 items-center justify-between gap-4 px-4"
                >
                    <dt class="shrink-0 text-muted-foreground">
                        Domain
                    </dt>
                    <dd
                        class="min-w-0 truncate font-mono text-[13px]"
                    >
                        {current.domain ?? "None"}
                    </dd>
                </div>
                {#if current.domain}
                    <div
                        class="flex h-11 items-center justify-between gap-4 px-4"
                    >
                        <dt class="text-muted-foreground">DNS</dt>
                        <dd>
                            {current.reserved
                                ? "Uncloud DNS"
                                : "Your DNS"}
                        </dd>
                    </div>
                {/if}
                {#if current.domain && !current.reserved}
                    <div
                        class="flex h-11 items-center justify-between gap-4 px-4"
                    >
                        <dt class="shrink-0 text-muted-foreground">
                            Record
                        </dt>
                        <dd
                            class="min-w-0 truncate font-mono text-[13px]"
                        >
                            *.{current.domain}
                        </dd>
                    </div>
                {/if}
            </dl>
        {/if}
    </FramePanel>
</Frame>
