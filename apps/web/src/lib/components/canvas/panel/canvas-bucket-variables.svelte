<!-- A bucket's connection settings and keys, laid out like the other resources' variable lists. -->
<script lang="ts">
    import { page } from "$app/state";
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
    import { client, orpc } from "$lib/api/orpc";
    import { bucketJobPollInterval } from "$lib/s3";
    import Braces from "@lucide/svelte/icons/braces";
    import EllipsisVertical from "@lucide/svelte/icons/ellipsis-vertical";
    import { createQuery } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import type { CanvasResource } from "../graph";
    import {
        VariableHeader,
        VariableRow,
        VariableValue,
    } from "$lib/components/ui/variable";

    let { resource }: { resource: CanvasResource } = $props();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
    });

    const bucketQuery = createQuery(() =>
        orpc.buckets.get.queryOptions({
            input,
            // The panel can open while the bucket is still being created.
            refetchInterval: (query) =>
                bucketJobPollInterval(query.state.data?.status),
            retry: false,
        }),
    );

    const bucket = $derived(bucketQuery.data);

    type Credentials = Awaited<
        ReturnType<typeof client.buckets.credentials>
    >;

    // Secrets are fetched only on request and never cached.
    let credentials = $state<Credentials>();

    let loadingKeys = $state(false);

    let error = $state("");

    const ready = $derived(bucket?.status === "ready");

    const variables = $derived(
        bucket
            ? [
                  {
                      key: "S3_ENDPOINT",
                      value: bucket.connection.endpoint,
                      secret: false,
                  },
                  {
                      key: "S3_REGION",
                      value: bucket.connection.region,
                      secret: false,
                  },
                  {
                      key: "S3_BUCKET",
                      value: bucket.name,
                      secret: false,
                  },
                  {
                      key: "S3_FORCE_PATH_STYLE",
                      value: String(bucket.connection.forcePathStyle),
                      secret: false,
                  },
                  {
                      key: "S3_ACCESS_KEY_ID",
                      value: credentials?.accessKey,
                      secret: true,
                  },
                  {
                      key: "S3_SECRET_ACCESS_KEY",
                      value: credentials?.secretKey,
                      secret: true,
                  },
              ]
            : [],
    );

    // Railway's variable search, kept in the URL like the open tab.
    const search = useQueryState(
        "variableSearch",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    const needle = $derived(
        search.current?.trim().toLowerCase() ?? "",
    );

    const shown = $derived(
        variables.filter((variable) =>
            variable.key.toLowerCase().includes(needle),
        ),
    );

    let revealed = $state(new Set<string>());

    async function loadCredentials() {
        if (credentials) return credentials;

        loadingKeys = true;
        error = "";

        try {
            credentials = await client.buckets.credentials(input);

            return credentials;
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Unable to load the access keys.";
        } finally {
            loadingKeys = false;
        }
    }

    async function toggle(variable: (typeof variables)[number]) {
        if (variable.secret && !(await loadCredentials())) return;

        const next = new Set(revealed);

        if (!next.delete(variable.key)) next.add(variable.key);

        revealed = next;
    }

    async function copy(variable: (typeof variables)[number]) {
        const value = variable.secret
            ? (await loadCredentials())?.[
                  variable.key === "S3_ACCESS_KEY_ID"
                      ? "accessKey"
                      : "secretKey"
              ]
            : variable.value;

        if (value !== undefined)
            await navigator.clipboard.writeText(value);
    }
</script>

<div class="space-y-4">
    {#if bucketQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load the bucket: {bucketQuery.error.message}
            </AlertDescription>
        </Alert>
    {:else if !bucket}
        <Skeleton loading count={6} label="Loading variables">
            <div
                class="flex h-10 items-center gap-4 px-4 font-mono text-sm"
            >
                <span>VARIABLE_NAME</span>
                <span>*******</span>
            </div>
        </Skeleton>
    {:else}
        <VariableHeader
            count={variables.length}
            search={search.current}
            onsearch={(value) => void search.set(value)}
        />

        <div class="border-t"></div>

        {#if error}
            <Alert variant="error">
                <AlertDescription>{error}</AlertDescription>
            </Alert>
        {/if}
        <ul>
            {#each shown as variable (variable.key)}
                {@const locked =
                    variable.secret &&
                    (!page.data.isOrganizationAdmin || !ready)}
                <VariableRow name={variable.key}>
                    {#snippet icon()}
                        <Braces
                            class="size-4 text-muted-foreground"
                            aria-hidden="true"
                        />
                    {/snippet}
                    <VariableValue
                        name={variable.key}
                        value={variable.value}
                        visible={revealed.has(variable.key) &&
                            variable.value !== undefined}
                        disabled={locked || loadingKeys}
                        ontoggle={() => void toggle(variable)}
                        oncopy={() => void copy(variable)}
                    />
                    {#snippet menu()}
                        <Menu>
                            <MenuTrigger
                                class="flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                                aria-label="{variable.key} actions"
                            >
                                <EllipsisVertical
                                    class="size-4"
                                    aria-hidden="true"
                                />
                            </MenuTrigger>
                            <MenuPopup align="end" class="min-w-40">
                                <MenuItem
                                    disabled={locked}
                                    onclick={() =>
                                        void copy(variable)}
                                >
                                    Copy value
                                </MenuItem>
                            </MenuPopup>
                        </Menu>
                    {/snippet}
                </VariableRow>
            {:else}
                <li class="px-4 py-3 text-sm text-muted-foreground">
                    No variables match "{search.current}".
                </li>
            {/each}
        </ul>
        <div class="border-t"></div>
    {/if}
</div>
