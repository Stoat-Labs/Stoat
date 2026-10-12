<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        AlertDialog,
        AlertDialogContent,
        AlertDialogDescription,
        AlertDialogFooter,
        AlertDialogHeader,
        AlertDialogTitle,
    } from "$lib/components/ui/alert-dialog";
    import { Button } from "$lib/components/ui/button";

    let {
        open = $bindable(false),
        reloading,
        forcing,
        reloadError,
        onreload,
        onforce,
    }: {
        open?: boolean;
        reloading: boolean;
        forcing: boolean;
        reloadError: string | undefined;
        onreload: () => void;
        onforce: () => void;
    } = $props();

    const pending = $derived(reloading || forcing);
</script>

<AlertDialog bind:open>
    <AlertDialogContent>
        <AlertDialogHeader>
            <AlertDialogTitle>Git branch changed</AlertDialogTitle>
            <AlertDialogDescription class="break-words">
                New commits changed the Compose file or its directory
                since this draft was loaded. Reload to replace the
                draft with the latest file from Git, or deploy anyway
                to commit your draft on top of the new head.
            </AlertDialogDescription>
        </AlertDialogHeader>
        {#if reloadError}
            <div class="px-6">
                <Alert variant="error">
                    <AlertDescription>{reloadError}</AlertDescription>
                </Alert>
            </div>
        {/if}
        <AlertDialogFooter>
            <Button
                variant="outline"
                disabled={pending}
                onclick={() => (open = false)}
            >
                Cancel
            </Button>
            <Button
                variant="outline"
                loading={reloading}
                disabled={forcing}
                onclick={onreload}
            >
                Reload from Git
            </Button>
            <Button
                variant="destructive"
                loading={forcing}
                disabled={reloading}
                onclick={onforce}
            >
                Deploy anyway
            </Button>
        </AlertDialogFooter>
    </AlertDialogContent>
</AlertDialog>
