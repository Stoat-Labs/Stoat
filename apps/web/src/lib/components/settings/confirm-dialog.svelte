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
        title,
        description,
        confirmLabel,
        pending = false,
        error = "",
        onconfirm,
    }: {
        open?: boolean;
        title: string;
        description: string;
        confirmLabel: string;
        pending?: boolean;
        error?: string;
        onconfirm: () => void;
    } = $props();
</script>

<AlertDialog bind:open>
    <AlertDialogContent>
        <AlertDialogHeader>
            <AlertDialogTitle>{title}</AlertDialogTitle>
            <AlertDialogDescription class="break-words">
                {description}
            </AlertDialogDescription>
        </AlertDialogHeader>
        {#if error}
            <div class="px-6">
                <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
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
                variant="destructive"
                loading={pending}
                onclick={onconfirm}
            >
                {confirmLabel}
            </Button>
        </AlertDialogFooter>
    </AlertDialogContent>
</AlertDialog>
