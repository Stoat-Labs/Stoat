<script lang="ts">
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import type { AppRouterClient } from "@stoat/api/routers/index";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        ToggleGroup,
        ToggleGroupItem,
    } from "$lib/components/ui/toggle-group";
    import {
        serviceUpdateOrder,
        setServiceUpdateOrder,
        type UpdateOrder,
    } from "@stoat/workflows/update-order";
    import * as v from "valibot";
    import type { CanvasResource, CanvasService } from "../../graph";
    import SettingsTitle from "./settings-title.svelte";
    import { Switch } from "$lib/components/ui/switch";

    type ResourceDetails = Awaited<
        ReturnType<AppRouterClient["resources"]["getResource"]>
    >;

    let {
        resource,
        services,
        settings,
        draftCompose,
        isInternal,
        savingDraft,
        saveDraft,
    }: {
        resource: CanvasResource;
        services: CanvasService[];
        settings: ResourceDetails["settings"] | undefined;
        draftCompose: string;
        isInternal: boolean;
        savingDraft: boolean;
        /** Resolves to the error message, or null once saved. */
        saveDraft: (compose: string) => Promise<string | null>;
    } = $props();

    const input = $derived({
        projectId: resource.projectId,
        resourceId: resource.id,
    });

    const settingsSchema = v.fallback(
        v.object({ prefixNames: v.fallback(v.boolean(), true) }),
        { prefixNames: true },
    );

    const prefixNames = $derived(
        v.parse(settingsSchema, settings).prefixNames,
    );

    let savingPrefix = $state(false);

    let prefixError = $state("");

    async function setPrefixNames(checked: boolean) {
        savingPrefix = true;
        prefixError = "";

        try {
            const updated = await client.resources.updateSettings({
                ...input,
                prefixNames: checked,
            });

            queryClient.setQueryData(
                orpc.resources.getResource.queryKey({ input }),
                updated,
            );
            // The Apply bar reads pending changes from the graph, which this setting changes.
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectGraph.key(),
            });
        } catch (cause) {
            prefixError =
                cause instanceof Error
                    ? cause.message
                    : "Could not save.";
        } finally {
            savingPrefix = false;
        }
    }

    // Per service; undefined when the draft can't be read, which hides its control.
    const updateOrders = $derived(
        services.map((service) => {
            try {
                return {
                    service: service.name,
                    order: serviceUpdateOrder(
                        draftCompose,
                        service.name,
                    ),
                };
            } catch {
                return { service: service.name, order: undefined };
            }
        }),
    );

    let updateOrderError = $state("");

    async function setUpdateOrder(
        service: string,
        value: string | null,
    ) {
        const order =
            value === "start-first" || value === "stop-first"
                ? value
                : null;

        try {
            updateOrderError =
                (await saveDraft(
                    setServiceUpdateOrder(
                        draftCompose,
                        service,
                        order,
                    ),
                )) ?? "";
        } catch (cause) {
            updateOrderError =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";
        }
    }
</script>

{#snippet updateOrderToggle(
    service: string,
    current: UpdateOrder | null | undefined,
)}
    {#if current !== undefined}
        <!-- auto leaves it unset: Uncloud starts first, or stops first for port conflicts and single-replica volumes. -->
        <ToggleGroup
            variant="outline"
            size="sm"
            aria-label={services.length === 1
                ? "Update order"
                : `Update order of ${service}`}
            value={[current ?? "auto"]}
            onValueChange={(next) => {
                // Pressing the active button would clear the group; keep the current order then.
                if (next[0]) void setUpdateOrder(service, next[0]);
            }}
        >
            {#each ["auto", "start-first", "stop-first"] as order (order)}
                <ToggleGroupItem
                    value={order}
                    disabled={savingDraft || isInternal}
                >
                    {order}
                </ToggleGroupItem>
            {/each}
        </ToggleGroup>
    {/if}
{/snippet}

<div>
    <div class="flex items-center justify-between gap-4">
        <SettingsTitle
            text={"Prefix Names"}
            description={"Changing it replaces services and starts volumes empty."}
        />
        <Switch
            aria-label="Prefix names"
            checked={prefixNames}
            disabled={savingPrefix || isInternal}
            onCheckedChange={(checked) =>
                void setPrefixNames(checked)}
        />
    </div>
    {#if prefixError}
        <Alert variant="error" class="mt-3">
            <AlertDescription>{prefixError}</AlertDescription>
        </Alert>
    {/if}
</div>
<div>
    {#if services.length === 1}
        <div class="flex items-center justify-between gap-4">
            <div>
                <SettingsTitle
                    text={"Update Order"}
                    description={"Use stop-first for databases."}
                />
            </div>
            {#each updateOrders as entry (entry.service)}
                {@render updateOrderToggle(
                    entry.service,
                    entry.order,
                )}
            {/each}
        </div>
    {:else}
        <SettingsTitle
            text={"Update Order"}
            description={"Use stop-first for databases."}
        />
        {#each updateOrders as entry (entry.service)}
            <div class="mt-3 flex items-center justify-between gap-4">
                <span class="truncate text-sm">
                    {entry.service}
                </span>
                {@render updateOrderToggle(
                    entry.service,
                    entry.order,
                )}
            </div>
        {/each}
    {/if}
    {#if updateOrderError}
        <Alert variant="error" class="mt-3">
            <AlertDescription>
                {updateOrderError}
            </AlertDescription>
        </Alert>
    {/if}
</div>
