<script lang="ts">
    import ConnectionField from "$lib/components/clusters/connection-field.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import type { AppRouterClient } from "@stoat/api/routers/index";

    let {
        connection,
        readOnly,
        enabling,
        canEnable,
        errorMessage,
        onEnable,
    }: {
        /** Undefined while the connection details are still loading. */
        connection:
            | NonNullable<
                  Awaited<
                      ReturnType<
                          AppRouterClient["resources"]["getConnection"]
                      >
                  >
              >
            | undefined;
        readOnly: boolean;
        enabling: boolean;
        canEnable: boolean;
        errorMessage: string | undefined;
        onEnable: () => void;
    } = $props();
</script>

{#if connection}
    <Frame
        class="min-w-0"
        role="region"
        aria-labelledby="connection-heading"
    >
        <FrameHeader>
            <FrameTitle class="text-base">
                <h2 id="connection-heading">Connection</h2>
            </FrameTitle>
        </FrameHeader>
        <FramePanel class="grid gap-4">
            <ConnectionField
                label="Internal URL"
                value={connection.internal}
                secret
            />
            {#if connection.external}
                <ConnectionField
                    label="External URL"
                    value={connection.external}
                    secret
                />
            {:else if connection.externalPort}
                <p class="text-sm text-muted-foreground">
                    External port {connection.externalPort} is configured,
                    but no machine address is available.
                </p>
            {/if}
            {#if connection.pendingDeployment}
                <p
                    role="status"
                    class="text-sm text-warning-foreground"
                >
                    External connection not deployed yet. Deploy to
                    apply the external port.
                </p>
            {/if}
            {#if !connection.externalPort && !readOnly}
                <div class="grid gap-2">
                    <Button
                        variant="outline"
                        size="sm"
                        onclick={onEnable}
                        loading={enabling}
                        disabled={!canEnable}
                    >
                        Enable external connection
                    </Button>
                    <p class="text-xs text-muted-foreground">
                        Adds an unused host port to the Compose draft.
                        After deployment, PostgreSQL will be reachable
                        outside the cluster wherever your firewall
                        allows.
                    </p>
                </div>
            {/if}
            {#if errorMessage !== undefined}
                <Alert variant="error">
                    <AlertDescription>
                        {errorMessage}
                    </AlertDescription>
                </Alert>
            {/if}
        </FramePanel>
    </Frame>
{:else}
    <Skeleton loading loading-label="Loading connection">
        <Frame class="min-w-0">
            <FrameHeader>
                <FrameTitle class="text-base">
                    <h2>Connection</h2>
                </FrameTitle>
            </FrameHeader>
            <FramePanel class="grid gap-4">
                <ConnectionField
                    label="Internal URL"
                    value="postgres://user:password@host:5432/db"
                    secret
                />
            </FramePanel>
        </Frame>
    </Skeleton>
{/if}
