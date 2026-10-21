<!-- Moves a resource (a card or a whole group) to another project, or copies it into one. -->
<script lang="ts">
    import { goto } from "$app/navigation";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
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
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import { client, orpc, queryClient } from "$lib/api/orpc";
    import { createQuery } from "@tanstack/svelte-query";
    import { untrack } from "svelte";
    import * as v from "valibot";
    import type { CanvasResource } from "../graph";

    let {
        mode: initialMode,
        projectId,
        resource,
        onclose,
    }: {
        mode: "move" | "copy";
        projectId: string;
        resource: CanvasResource;
        onclose: () => void;
    } = $props();

    // A deployed resource can't move to another cluster, so the dialog offers to copy it instead.
    let mode = $state(untrack(() => initialMode));

    let targetId = $state("");

    let editedName = $state<string | null>(null);

    let pending = $state(false);

    let error = $state("");

    const projectsQuery = createQuery(() =>
        orpc.projects.listProjects.queryOptions(),
    );

    const resourceQuery = createQuery(() =>
        orpc.resources.getResource.queryOptions({
            input: { projectId, resourceId: resource.id },
        }),
    );

    const settingsSchema = v.fallback(
        v.object({ prefixNames: v.fallback(v.boolean(), true) }),
        { prefixNames: true },
    );

    const prefixed = $derived(
        v.parse(settingsSchema, resourceQuery.data?.settings)
            .prefixNames,
    );

    const projects = $derived(
        (projectsQuery.data ?? []).filter(
            (project) => mode === "copy" || project.id !== projectId,
        ),
    );

    const source = $derived(
        projectsQuery.data?.find(
            (project) => project.id === projectId,
        ),
    );

    const target = $derived(
        projects.find((project) => project.id === targetId),
    );

    const name = $derived(
        editedName ??
            (targetId === projectId
                ? `${resource.name} copy`
                : resource.name),
    );

    const otherCluster = $derived(
        Boolean(
            target && source && target.clusterId !== source.clusterId,
        ),
    );

    // Its services keep running on this cluster, where nothing would manage them any more.
    const blocked = $derived(
        mode === "move" &&
            otherCluster &&
            resource.deploymentId !== null,
    );

    const ready = $derived(
        Boolean(target) &&
            !blocked &&
            !pending &&
            (mode === "move" || Boolean(name.trim())),
    );

    function projectLabel(id: string, label: string) {
        return id === projectId ? `${label} (this project)` : label;
    }

    async function submit(event: Event) {
        event.preventDefault();

        if (!ready) return;

        pending = true;
        error = "";

        try {
            const input = {
                projectId,
                resourceId: resource.id,
                toProjectId: targetId,
            };

            const result =
                mode === "move"
                    ? await client.resources.moveResource(input)
                    : await client.resources.copyResource({
                          ...input,
                          name: name.trim(),
                      });

            await Promise.all([
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.getProjectGraph.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.resources.listResources.key(),
                }),
                queryClient.invalidateQueries({
                    queryKey: orpc.projects.key(),
                }),
            ]);

            onclose();
            await goto(
                `/projects/${targetId}/canvas?node=${result.id}`,
            );
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : `Unable to ${mode} the resource.`;
        } finally {
            pending = false;
        }
    }
</script>

<Dialog
    bind:open={
        () => true,
        (open) => {
            if (!open && !pending) onclose();
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>
                {mode === "move" ? "Move" : "Copy"}
                {resource.name}
            </DialogTitle>
            <DialogDescription>
                {mode === "move"
                    ? "It leaves this canvas and lands on the other project's, as it is."
                    : "Its Compose, variables, icon and Git source become a new draft that deploys with the next apply."}
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            <form
                id="canvas-transfer-form"
                class="space-y-4"
                onsubmit={submit}
                oninput={() => (error = "")}
            >
                <Field>
                    <Label for="canvas-transfer-project" required>
                        Project
                    </Label>
                    <Select
                        value={targetId || null}
                        items={projects.map((project) => ({
                            value: project.id,
                            label: projectLabel(
                                project.id,
                                project.name,
                            ),
                        }))}
                        disabled={projectsQuery.isPending}
                        onValueChange={(value) =>
                            (targetId = value ?? "")}
                    >
                        <SelectTrigger id="canvas-transfer-project">
                            <SelectValue
                                placeholder="Choose a project"
                            />
                        </SelectTrigger>
                        <SelectContent>
                            {#each projects as project (project.id)}
                                <SelectItem
                                    value={project.id}
                                    label={projectLabel(
                                        project.id,
                                        project.name,
                                    )}
                                />
                            {/each}
                        </SelectContent>
                    </Select>
                </Field>

                {#if mode === "copy"}
                    <Field>
                        <Label for="canvas-transfer-name" required>
                            Name
                        </Label>
                        <Input
                            id="canvas-transfer-name"
                            bind:value={
                                () => name,
                                (value) => (editedName = value)
                            }
                            maxlength={100}
                            disabled={pending}
                        />
                    </Field>

                    {#if prefixed}
                        <Alert variant="info">
                            <AlertDescription>
                                Volumes aren't copied. The copy gets
                                its own service and volume names on
                                the cluster, so its volumes start
                                empty.
                            </AlertDescription>
                        </Alert>
                    {:else}
                        <Alert variant="warning">
                            <AlertDescription>
                                Prefix names is off, so the copy uses
                                the same service and volume names as
                                the original. Deployed on the same
                                cluster, it takes over the original's
                                containers and volumes. Turn Prefix
                                names on for the copy to keep them
                                apart.
                            </AlertDescription>
                        </Alert>
                    {/if}
                {/if}

                {#if blocked}
                    <Alert variant="warning">
                        <AlertDescription>
                            That project is on another cluster, and
                            this resource runs on its current one.
                            Copy it instead.
                        </AlertDescription>
                    </Alert>
                {:else if otherCluster}
                    <p class="text-xs text-muted-foreground">
                        That project is on another cluster. Variable
                        references to other resources only work within
                        one cluster.
                    </p>
                {/if}

                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button
                variant="outline"
                onclick={onclose}
                disabled={pending}
            >
                Cancel
            </Button>
            {#if blocked}
                <Button onclick={() => (mode = "copy")}>
                    Copy instead
                </Button>
            {:else}
                <Button
                    type="submit"
                    form="canvas-transfer-form"
                    loading={pending}
                    disabled={!ready}
                >
                    {mode === "move" ? "Move" : "Copy"}
                </Button>
            {/if}
        </DialogFooter>
    </DialogContent>
</Dialog>
