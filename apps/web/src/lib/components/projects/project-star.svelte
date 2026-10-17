<!-- Railway's favorite star; it sits above the card's full-size link. -->
<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import Star from "@lucide/svelte/icons/star";

    let {
        name,
        favorite,
        onfavorite,
    }: {
        name: string;
        favorite: boolean;
        /** Omitted while loading, where the star is only a placeholder. */
        onfavorite?: (favorite: boolean) => void;
    } = $props();
</script>

<Button
    variant="ghost"
    size="icon-sm"
    class="relative z-10 shrink-0 text-muted-foreground"
    aria-label={favorite
        ? `Remove ${name} from favorites`
        : `Add ${name} to favorites`}
    aria-pressed={favorite}
    disabled={!onfavorite}
    onclick={() => onfavorite?.(!favorite)}
>
    <Star
        class={["size-4", favorite && "fill-warning text-warning"]}
        aria-hidden="true"
    />
</Button>
