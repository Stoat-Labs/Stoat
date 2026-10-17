<script lang="ts">
    import GitSourceFields from "$lib/components/projects/git-source-fields.svelte";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import type { GitSourceInput } from "$lib/resources/git-source-actions.svelte";

    let {
        open = $bindable(false),
        source,
        busy,
        onsubmit,
    }: {
        open?: boolean;
        /** The bound source to start from; null connects a new one. */
        source: GitSourceInput | null;
        busy: boolean;
        onsubmit: (source: GitSourceInput) => Promise<boolean>;
    } = $props();

    let connectionId = $state("");

    let repositoryUrl = $state("");

    let branch = $state("");

    let path = $state(".");

    // Each opening starts from the saved source.
    $effect(() => {
        if (!open) return;

        connectionId = source?.connectionId ?? "";
        repositoryUrl = source?.repositoryUrl ?? "";
        branch = source?.branch ?? "";
        path = source?.path ?? ".";
    });

    const complete = $derived(
        Boolean(
            connectionId &&
            repositoryUrl &&
            branch.trim() &&
            path.trim(),
        ),
    );
</script>

<Dialog bind:open>
    <DialogContent class="max-w-lg">
        <form
            class="contents"
            onsubmit={async (event) => {
                event.preventDefault();

                const saved = await onsubmit({
                    connectionId,
                    repositoryUrl,
                    branch: branch.trim(),
                    path: path.trim(),
                });

                if (saved) open = false;
            }}
        >
            <DialogHeader>
                <DialogTitle>
                    {source ? "Change source" : "Connect repo"}
                </DialogTitle>
                <DialogDescription>
                    Stoat reads the Compose file and the files its
                    configs point to from this branch. Nothing is
                    built.
                </DialogDescription>
            </DialogHeader>
            <DialogPanel>
                <GitSourceFields
                    bind:connectionId
                    bind:repositoryUrl
                    bind:branch
                    bind:path
                    disabled={busy}
                />
            </DialogPanel>
            <DialogFooter>
                <Button
                    variant="outline"
                    type="button"
                    onclick={() => (open = false)}
                >
                    Cancel
                </Button>
                <Button
                    type="submit"
                    loading={busy}
                    disabled={busy || !complete}
                >
                    {source ? "Import & bind" : "Connect"}
                </Button>
            </DialogFooter>
        </form>
    </DialogContent>
</Dialog>
