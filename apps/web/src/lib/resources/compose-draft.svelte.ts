import { beforeNavigate, goto } from "$app/navigation";
import { orpc, queryClient } from "$lib/api/orpc";
import type { AppRouterClient } from "@stoat/api/routers/index";
import { createMutation } from "@tanstack/svelte-query";
import { Debounced } from "runed";
import { onDestroy, untrack } from "svelte";

type Resource = NonNullable<Awaited<ReturnType<AppRouterClient["resources"]["getResource"]>>>;

type SavedSource = {
    connectionId: string;
    repositoryUrl: string;
    branch: string;
    path: string;
    revision: string;
};

/** What the draft edits: read on every change, so pass getters over live page state. */
export type ComposeDraftTarget = {
    projectId: () => string;
    resourceId: () => string;
    resource: () => Resource | undefined;
    readOnly: () => boolean;
    /** Another request that changes the draft is running: autosave and navigation wait for it. */
    busy: () => boolean;
    /** Autosave waits while this is true, e.g. while the text cannot be parsed. */
    paused: () => boolean;
    /** Runs when the route switches to another resource, after the draft itself resets. */
    onSwitch: () => void;
};

function sourceOf(resource: Resource): SavedSource | null {
    if (!resource.gitConnectionId || !resource.gitSource) return null;

    return { connectionId: resource.gitConnectionId, ...resource.gitSource };
}

/**
 * The autosaved Compose draft shared by the resource overview and Ingress pages.
 *
 * Edits save 800ms after typing stops. Saves send the last saved spec and Git source, so a
 * concurrent change elsewhere fails instead of being overwritten. Leaving the page with unsaved
 * edits saves them first; closing the tab cannot wait, so the browser asks instead.
 *
 * Construct it during component initialisation: it registers navigation and lifecycle hooks.
 */
export class ComposeDraft {
    compose = $state("");

    /** The draft spec last confirmed by the server; `null` before a resource has loaded. */
    savedSpec = $state<string | null>(null);

    /** The resource whose draft is in the editor; empty while switching resources. */
    loadedResourceId = $state("");

    readonly isDirty = $derived(this.compose !== (this.savedSpec ?? ""));

    readonly save = createMutation(() =>
        orpc.resources.updateComposeSpec.mutationOptions({
            onSuccess: (updated, input) => {
                if (
                    this.#active &&
                    this.#target.projectId() === input.projectId &&
                    this.#target.resourceId() === input.resourceId &&
                    this.loadedResourceId === updated.id
                ) {
                    this.savedSpec = updated.draftSpec;
                    this.#savedSource = sourceOf(updated);
                }

                queryClient.setQueryData(
                    orpc.resources.getResource.queryKey({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                    updated,
                );
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.getContainers.key({
                        input: { projectId: input.projectId, resourceId: input.resourceId },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectContainers.key({
                        input: { projectId: input.projectId },
                    }),
                });
                void queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.queryKey({
                        input: { projectId: input.projectId },
                    }),
                });
            },
        }),
    );

    #target: ComposeDraftTarget;

    #savedSource = $state<SavedSource | null>(null);

    #debounced = new Debounced(() => this.compose, 800);

    #active = true;

    /** The navigation this guard resumes after saving; query state may still read busy. */
    #resumedTo = "";

    constructor(target: ComposeDraftTarget) {
        this.#target = target;

        beforeNavigate((navigation) => {
            if (navigation.to?.url.href === this.#resumedTo) return;

            if (!this.busy && !this.isDirty) return;
            navigation.cancel();

            if (navigation.willUnload || this.busy || !navigation.to) return;
            const destination = navigation.to.url;
            void this.saveNow().then((saved) => {
                if (!saved) return;
                this.#resumedTo = destination.href;
                void goto(destination);
            });
        });

        onDestroy(() => {
            this.#active = false;
            this.#debounced.cancel();
        });

        // Route components are reused when switching between resources.
        $effect(() => {
            void target.projectId();
            void target.resourceId();
            untrack(() => {
                this.#debounced.cancel();
                this.loadedResourceId = "";
                this.compose = "";
                this.savedSpec = null;
                this.#savedSource = null;
                this.save.reset();
                target.onSwitch();
            });
        });

        // Load the draft once, then follow refetches until the user starts editing.
        $effect(() => {
            const current = target.resource();

            if (!current || current.id !== target.resourceId()) return;
            untrack(() => {
                const first = this.loadedResourceId !== current.id;

                if (!first && (this.isDirty || this.busy)) return;
                this.loadedResourceId = current.id;
                this.accept(current);

                if (first) this.save.reset();
            });
        });

        // Autosave once typing settles.
        $effect(() => {
            const text = this.#debounced.current;
            const settled = !this.#debounced.pending && this.compose === text;
            const baseline = this.savedSpec;
            const baselineSource = this.#savedSource;
            const projectId = target.projectId();
            const resourceId = target.resourceId();

            const ready =
                !target.readOnly() &&
                !target.busy() &&
                !target.paused() &&
                !this.save.isPending &&
                resourceId !== "" &&
                this.loadedResourceId === resourceId;

            if (!settled || text === (baseline ?? "") || !ready) return;

            untrack(() => {
                this.save.mutate({
                    projectId,
                    resourceId,
                    spec: text,
                    expectedSpec: baseline,
                    expectedSource: baselineSource ? { ...baselineSource } : null,
                });
            });
        });
    }

    /** A save or another draft request is running. */
    get busy() {
        return this.save.isPending || this.#target.busy();
    }

    /** True once the route's resource is the one in the editor. */
    get loaded() {
        return this.loadedResourceId !== "" && this.loadedResourceId === this.#target.resourceId();
    }

    /** The saved Git source, for server calls that guard against concurrent edits. */
    get savedSource() {
        return this.#savedSource ? { ...this.#savedSource } : null;
    }

    /** Replaces the editor text and baseline with a resource the server returned. */
    accept(resource: Resource) {
        this.compose = resource.draftSpec ?? "";
        this.savedSpec = resource.draftSpec;
        this.#savedSource = sourceOf(resource);
        this.#debounced.setImmediately(this.compose);
    }

    /** Saves the editor text without waiting for the autosave delay; false if it failed. */
    async saveNow() {
        const resourceId = this.#target.resourceId();

        if (this.#target.readOnly() || this.loadedResourceId !== resourceId) return false;
        this.#debounced.cancel();

        try {
            await this.save.mutateAsync({
                projectId: this.#target.projectId(),
                resourceId,
                spec: this.compose,
                expectedSpec: this.savedSpec,
                expectedSource: this.savedSource,
            });

            return true;
        } catch {
            // The page shows the save error.
            return false;
        }
    }
}
