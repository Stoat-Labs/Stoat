<script lang="ts" module>
    export type GridColumn = {
        /** Position in each row. */
        index: number;
        name: string;
        type?: string;
        primary?: boolean;
    };

    export type GridSort = { column: string; desc: boolean };
</script>

<script lang="ts">
    import ArrowDown from "@lucide/svelte/icons/arrow-down";
    import ArrowUp from "@lucide/svelte/icons/arrow-up";
    import ArrowUpDown from "@lucide/svelte/icons/arrow-up-down";
    import KeyRound from "@lucide/svelte/icons/key-round";

    let {
        columns,
        rows,
        sort,
        onsort,
    }: {
        columns: GridColumn[];
        rows: (string | null)[][];
        sort?: GridSort | null;
        /** Absent for SQL results, which sort in the query itself. */
        onsort?: (column: string) => void;
    } = $props();
</script>

<!-- A spreadsheet-like grid: the header stays put while rows scroll under it. -->
<table class="w-max min-w-full border-collapse font-mono text-xs">
    <thead class="sticky top-0 z-10 bg-background">
        <tr>
            {#each columns as column (column.index)}
                {@const active = sort?.column === column.name}
                <th
                    class="border-r border-b px-3 py-2 text-left font-normal whitespace-nowrap last:border-r-0"
                    aria-sort={active
                        ? sort?.desc
                            ? "descending"
                            : "ascending"
                        : undefined}
                >
                    <div class="flex items-center gap-2">
                        {#if column.primary}
                            <KeyRound
                                class="size-3 text-muted-foreground"
                                aria-label="Primary key"
                            />
                        {/if}
                        <span class="font-sans font-medium">
                            {column.name}
                        </span>
                        {#if column.type}
                            <span class="text-muted-foreground">
                                {column.type}
                            </span>
                        {/if}
                        {#if onsort}
                            {@const Icon = active
                                ? sort?.desc
                                    ? ArrowDown
                                    : ArrowUp
                                : ArrowUpDown}
                            <button
                                type="button"
                                class={[
                                    "ml-auto rounded p-0.5 hover:bg-accent",
                                    active
                                        ? "text-foreground"
                                        : "text-muted-foreground",
                                ]}
                                aria-label="Sort by {column.name}"
                                onclick={() => onsort(column.name)}
                            >
                                <Icon class="size-3.5" />
                            </button>
                        {/if}
                    </div>
                </th>
            {/each}
        </tr>
    </thead>
    <tbody>
        {#each rows as row, index (index)}
            <tr class="hover:bg-accent/50">
                {#each columns as column (column.index)}
                    {@const value = row[column.index] ?? null}
                    <td
                        class="max-w-80 truncate border-r border-b px-3 py-2 last:border-r-0"
                        title={value ?? undefined}
                    >
                        {#if value === null}
                            <span class="text-muted-foreground">
                                NULL
                            </span>
                        {:else}
                            {value}
                        {/if}
                    </td>
                {/each}
            </tr>
        {/each}
    </tbody>
</table>
