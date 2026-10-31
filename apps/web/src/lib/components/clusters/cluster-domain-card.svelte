<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardDescription,
        CardHeader,
        CardPanel,
        CardTitle,
    } from "$lib/components/ui/card";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { orpc } from "$lib/api/orpc";
    import CircleAlert from "@lucide/svelte/icons/circle-alert";
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

    const managedBy = $derived.by(() => {
        if (!current?.domain) return "Not set";

        return current.reserved ? "Uncloud DNS" : "Your DNS";
    });
</script>

<Card>
    <CardHeader
        class="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5"
    >
        <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
                <CardTitle class="text-base">
                    Cluster domain
                </CardTitle>
                {#if current}
                    <Badge
                        variant={current.domain
                            ? "success"
                            : "secondary"}
                    >
                        {managedBy}
                    </Badge>
                {/if}
            </div>
            <CardDescription class="mt-1">
                Services published without a hostname get one under
                this domain.
            </CardDescription>
        </div>
        {#if current?.canManage}
            <div class="flex shrink-0 flex-wrap items-center gap-2">
                {#if current.domain}
                    <Button
                        variant="ghost"
                        size="sm"
                        onclick={() => onopendialog("remove-domain")}
                    >
                        Remove
                    </Button>
                {/if}
                <Button
                    variant="outline"
                    size="sm"
                    onclick={() => onopendialog("domain")}
                >
                    {current.domain ? "Change domain" : "Set domain"}
                </Button>
            </div>
        {/if}
    </CardHeader>
    <CardPanel class="p-4 pt-0 sm:p-5 sm:pt-0">
        {#if domainQuery.isPending}
            <Skeleton loading label="Loading the cluster domain">
                <p class="text-sm">Domain x9tx94.uncld.dev</p>
            </Skeleton>
        {:else if domainQuery.isError}
            <Alert variant="error">
                <CircleAlert aria-hidden="true" />
                <AlertDescription>
                    Unable to load the cluster domain: {domainQuery
                        .error.message}
                </AlertDescription>
            </Alert>
        {:else if current}
            <dl class="grid gap-1 text-sm sm:grid-cols-[8rem_1fr]">
                <dt class="text-muted-foreground">Domain</dt>
                <dd class="min-w-0 truncate font-mono text-[13px]">
                    {current.domain ?? "None"}
                </dd>
                {#if current.domain && !current.reserved}
                    <dt class="text-muted-foreground">DNS record</dt>
                    <dd
                        class="min-w-0 truncate font-mono text-[13px]"
                    >
                        *.{current.domain}
                    </dd>
                {/if}
            </dl>
        {/if}
    </CardPanel>
</Card>
