<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import Box from "@lucide/svelte/icons/box";
</script>

<!-- Placeholder shaped like a container row; only rendered inside a loading Skeleton. -->
<div
    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 p-3 sm:grid-cols-[auto_minmax(0,1fr)_auto]"
>
    <span
        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
    >
        <Box class="size-5" aria-hidden="true" />
    </span>
    <div class="min-w-0">
        <h3 class="truncate text-sm font-medium leading-5">
            Container service
        </h3>
        <p
            class="mt-1 truncate text-xs leading-5 text-muted-foreground"
        >
            image:latest &middot; machine
        </p>
    </div>
    <Badge variant="secondary" class="col-start-2 sm:col-start-auto">
        Healthy
    </Badge>
</div>
