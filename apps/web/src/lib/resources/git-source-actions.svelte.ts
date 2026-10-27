import { client, orpc, queryClient } from "$lib/api/orpc";
import type { AppRouterClient } from "@stoat/api/routers/index";

type Resource = Awaited<ReturnType<AppRouterClient["resources"]["getResource"]>>;

export type GitAction = "source" | "pull" | "detach" | "push" | "watch";

export type GitSourceInput = {
    connectionId: string;
    repositoryUrl: string;
    branch: string;
    path: string;
};

const statusMessages: Record<GitAction, string> = {
    source: "Compose imported from Git.",
    pull: "Compose imported from Git.",
    push: "Commit pushed and draft saved.",
    detach: "Git source detached. Compose retained.",
    watch: "Auto-deploy settings saved.",
};

/**
 * Git source actions for one resource, shared by the resource page and the canvas.
 * Every write sends the draft and source it was based on, so a concurrent change fails instead of being overwritten.
 */
export class GitSourceActions {
    pending = $state(false);

    error = $state("");

    status = $state("");

    /** A Git action waiting for an answer in a confirmation dialog. */
    confirmation = $state<{
        title: string;
        description: string;
        confirmLabel: string;
        answer: (confirmed: boolean) => void;
    } | null>(null);

    readonly #projectId: () => string;

    readonly #resourceId: () => string;

    readonly #resource: () => Resource | undefined;

    constructor(
        projectId: () => string,
        resourceId: () => string,
        resource: () => Resource | undefined,
    ) {
        this.#projectId = projectId;
        this.#resourceId = resourceId;
        this.#resource = resource;
    }

    // Settings has no editor, so the saved draft is the only Compose to compare and push.
    get savedSpec() {
        return this.#resource()?.draftSpec ?? null;
    }

    get savedSource() {
        const resource = this.#resource();

        return resource?.gitConnectionId && resource.gitSource
            ? { connectionId: resource.gitConnectionId, ...resource.gitSource }
            : null;
    }

    answer(confirmed: boolean) {
        this.confirmation?.answer(confirmed);
        this.confirmation = null;
    }

    #confirm(title: string, description: string, confirmLabel: string) {
        return new Promise<boolean>((answer) => {
            this.confirmation = { title, description, confirmLabel, answer };
        });
    }

    async run(
        action: GitAction,
        source?: GitSourceInput,
        message?: string,
        watch?: { autoDeploy: boolean; watchPath: string },
    ) {
        if (this.pending || !this.#resource()) return false;

        if (
            (action === "source" || action === "pull") &&
            this.savedSpec !== null &&
            !(await this.#confirm(
                "Replace the Compose draft?",
                "The Git version replaces the saved draft.",
                "Replace",
            ))
        )
            return false;

        if (
            action === "detach" &&
            !(await this.#confirm(
                "Detach the Git source?",
                "The current Compose draft is kept.",
                "Detach",
            ))
        )
            return false;

        if (this.pending) return false;

        const input = { projectId: this.#projectId(), resourceId: this.#resourceId() };

        const expectedSpec = this.savedSpec;

        const expectedSource = this.savedSource ? { ...this.savedSource } : null;

        const expectedRevision = expectedSource?.revision;

        this.pending = true;
        this.error = this.status = "";

        try {
            let updated;

            if (action === "source" && source) {
                updated = await client.resources.setGitSource({
                    ...input,
                    ...source,
                    expectedSpec,
                    expectedSource,
                });
            } else if (action === "pull") {
                updated = await client.resources.pullGitSource({
                    ...input,
                    expectedSpec,
                    expectedSource,
                });
            } else if (action === "detach") {
                updated = await client.resources.detachGitSource({
                    ...input,
                    expectedSpec,
                    expectedSource,
                });
            } else if (action === "push" && expectedRevision && message?.trim()) {
                updated = await client.resources.pushGitSource({
                    ...input,
                    spec: expectedSpec ?? "",
                    expectedSpec,
                    expectedSource,
                    expectedRevision,
                    message: message.trim(),
                });
            } else if (action === "watch" && watch) {
                updated = await client.resources.setGitWatch({
                    ...input,
                    ...watch,
                    expectedSpec,
                    expectedSource,
                });
            } else return false;

            queryClient.setQueryData(orpc.resources.getResource.queryKey({ input }), updated);
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.listResources.queryKey({
                    input: { projectId: input.projectId },
                }),
            });
            void queryClient.invalidateQueries({ queryKey: orpc.resources.getProjectGraph.key() });
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getContainers.key({ input }),
            });
            void queryClient.invalidateQueries({
                queryKey: orpc.resources.getProjectContainers.key({
                    input: { projectId: input.projectId },
                }),
            });
            this.status = statusMessages[action];

            return true;
        } catch (cause) {
            this.error = cause instanceof Error ? cause.message : "Git operation failed.";

            return false;
        } finally {
            this.pending = false;
        }
    }
}
