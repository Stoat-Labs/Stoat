<script lang="ts">
    import { buttonVariants } from "$lib/components/ui/button";
    import { Button } from "$lib/components/ui/button";
    import { Checkbox } from "$lib/components/ui/checkbox";
    import { Input } from "$lib/components/ui/input";
    import {
        Popover,
        PopoverPopup,
        PopoverTitle,
        PopoverTrigger,
    } from "$lib/components/ui/popover";
    import ChevronDown from "@lucide/svelte/icons/chevron-down";

    let {
        services,
        selectedIds,
        selectedCount,
        search = $bindable(""),
        onSelect,
        onToggleAll,
    }: {
        services: { id: string; name: string }[];
        selectedIds: string[];
        /** selection?.length ?? selectedIds.length: null means "all". */
        selectedCount: number | null;
        search: string;
        onSelect: (name: string, checked: boolean) => void;
        onToggleAll: () => void;
    } = $props();

    const visible = $derived(
        services.filter((service) =>
            service.name.toLowerCase().includes(search.toLowerCase()),
        ),
    );
</script>

<Popover>
    <PopoverTrigger
        class={buttonVariants({ variant: "outline", size: "sm" })}
    >
        {selectedIds.length === services.length
            ? "All services"
            : `${selectedIds.length} services`}<ChevronDown
            class="size-3.5"
            aria-hidden="true"
        />
    </PopoverTrigger>
    <PopoverPopup align="start" class="w-80 max-w-[calc(100vw-2rem)]">
        <PopoverTitle class="mb-2 text-sm font-medium">
            Services
        </PopoverTitle>
        <Input
            size="sm"
            type="search"
            aria-label="Find a service"
            placeholder="Find a service..."
            bind:value={search}
        />
        <div
            class="my-2 flex items-center justify-between text-xs text-muted-foreground"
        >
            <span>Select up to 20</span>
            <Button variant="ghost" size="xs" onclick={onToggleAll}>
                {selectedCount ? "Clear" : "Select all"}
            </Button>
        </div>
        <div class="max-h-64 space-y-1 overflow-y-auto">
            {#each visible as service (service.id)}
                <label
                    for={`log-service-${service.id}`}
                    class="flex min-h-9 cursor-pointer items-center gap-2 rounded-md px-1.5 hover:bg-muted"
                >
                    <Checkbox
                        id={`log-service-${service.id}`}
                        checked={selectedIds.includes(service.id)}
                        onCheckedChange={(checked) =>
                            onSelect(service.name, checked)}
                        disabled={!selectedIds.includes(service.id) &&
                            (selectedCount ?? selectedIds.length) >=
                                20}
                    />
                    <span
                        class="min-w-0 truncate text-sm"
                        title={service.name}
                    >
                        {service.name}
                    </span>
                </label>
            {/each}
            {#if !visible.length}<p
                    class="py-3 text-sm text-muted-foreground"
                >
                    No matching services.
                </p>{/if}
        </div>
    </PopoverPopup>
</Popover>
