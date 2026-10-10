<script lang="ts">
    import CodeEditor from "$lib/components/shared/code-editor.svelte";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import {
        Frame,
        FrameDescription,
        FrameHeader,
        FramePanel,
        FrameTitle,
    } from "$lib/components/ui/frame";
    import PreviewComposeDialog from "./preview-compose-dialog.svelte";

    let {
        projectId,
        resourceId,
        editorKey,
        compose = $bindable(),
        readOnly,
        editorLocked,
        saveStatus,
        saveError,
        deployError,
        composeError,
    }: {
        projectId: string;
        resourceId: string;
        compose: string;
        /** Recreates the editor when the loaded resource changes. */
        editorKey: string;
        /** System-managed resources cannot be edited. */
        readOnly: boolean;
        /** Blocks typing while a mutation or the initial load is in flight. */
        editorLocked: boolean;
        /** Autosave state shown beside the title; empty when nothing to report. */
        saveStatus: "" | "saving" | "unsaved" | "saved";
        saveError: string | undefined;
        deployError: string | undefined;
        /** Why the saved draft cannot be deployed, if it cannot. */
        composeError: string | undefined;
    } = $props();
</script>

<Frame
    id="compose-editor"
    class="min-w-0 xl:col-span-3 xl:row-span-2 xl:grid xl:min-h-0 xl:grid-rows-subgrid"
    role="region"
    aria-labelledby="compose-heading"
>
    <FrameHeader
        class="shrink-0 flex-row flex-wrap items-start justify-between gap-2"
    >
        <div class="min-w-0">
            <FrameTitle class="text-base">
                <h2 id="compose-heading">Docker Compose</h2>
            </FrameTitle>
        </div>
        <div class="flex flex-wrap items-center gap-2">
            <div class="text-sm" aria-live="polite">
                {#if saveError !== undefined}
                    <Alert variant="error" class="w-auto px-2 py-1.5">
                        <AlertDescription>
                            Unable to save: {saveError}
                        </AlertDescription>
                    </Alert>
                {:else if saveStatus === "saving"}
                    <p class="text-muted-foreground">Saving...</p>
                {:else if saveStatus === "unsaved"}
                    <p class="text-muted-foreground">
                        Unsaved changes
                    </p>
                {:else if saveStatus === "saved"}
                    <p class="text-muted-foreground">Draft saved.</p>
                {/if}
            </div>
            <PreviewComposeDialog {projectId} {resourceId} />
            {#if readOnly}
                <Badge variant="secondary">System-managed</Badge>
            {/if}
            {#if deployError !== undefined}
                <Alert variant="error" class="w-full">
                    <AlertDescription>
                        Unable to deploy: {deployError}
                    </AlertDescription>
                </Alert>
            {:else if composeError !== undefined}
                <Alert variant="error" class="w-full">
                    <AlertDescription>
                        Saved draft cannot be deployed: {composeError}
                    </AlertDescription>
                </Alert>
            {/if}
        </div>
    </FrameHeader>
    <FramePanel
        class="min-h-0 overflow-hidden bg-code p-0 transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-2 focus-within:ring-ring/20 dark:bg-black/20"
    >
        <div class="compose-editor-canvas">
            {#key editorKey}
                <CodeEditor
                    bind:value={compose}
                    readOnly={readOnly || editorLocked}
                />
            {/key}
        </div>
    </FramePanel>
</Frame>

<style>
    @media (min-width: 80rem) {
        .compose-editor-canvas,
        .compose-editor-canvas > :global(div),
        .compose-editor-canvas :global(.cm-editor) {
            height: 100%;
            min-height: 0;
        }

        .compose-editor-canvas :global(.cm-scroller) {
            min-height: 0;
            max-height: none;
        }
    }
</style>
