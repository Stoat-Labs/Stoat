<script lang="ts">
    import {
        afterNavigate,
        beforeNavigate,
        goto,
    } from "$app/navigation";
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";

    let { dirty }: { dirty: boolean } = $props();

    let open = $state(false);

    let destination: URL | null = null;

    let discarding = false;

    beforeNavigate((navigation) => {
        // Query-only changes, like search params, keep the page and its edits.
        if (
            !dirty ||
            discarding ||
            navigation.to?.url.pathname ===
                navigation.from?.url.pathname
        )
            return;
        navigation.cancel();

        // The browser asks on its own before reloading or closing the tab.
        if (navigation.willUnload || !navigation.to) return;
        destination = navigation.to.url;
        open = true;
    });

    // Pages are reused across routes, so re-arm once the discarded navigation lands.
    afterNavigate(() => {
        discarding = false;
    });

    function discard() {
        if (!destination) return;
        discarding = true;
        open = false;
        void goto(destination);
    }
</script>

<ConfirmDialog
    bind:open
    title="Discard unsaved changes?"
    description="Leaving this page loses the changes you haven't saved."
    confirmLabel="Discard changes"
    onconfirm={discard}
/>
