<script lang="ts">
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
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Textarea } from "$lib/components/ui/textarea";
    import { orpc, queryClient } from "$lib/api/orpc";
    import Info from "@lucide/svelte/icons/info";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { watch } from "runed";

    // Only prefilled when Caddy is not deployed yet.
    const DEFAULT_IMAGE = "caddy:2";

    let {
        open = $bindable(false),
        clusterId,
        ondeployed,
    }: {
        open?: boolean;
        clusterId: string;
        ondeployed: (deploymentId: string, clusterId: string) => void;
    } = $props();

    let image = $state("");

    let caddyfile = $state("");

    const caddyQuery = createQuery(() =>
        orpc.cluster.getCaddy.queryOptions({ input: { clusterId } }),
    );

    const deployMutation = createMutation(() =>
        orpc.cluster.deployCaddy.mutationOptions({
            onSuccess: ({ deploymentId }, variables) => {
                void queryClient.invalidateQueries({
                    queryKey: orpc.cluster.getCaddy.queryKey({
                        input: { clusterId: variables.clusterId },
                    }),
                });
                open = false;
                ondeployed(deploymentId, variables.clusterId);
            },
        }),
    );

    // Prefill from the live service once per opening, as soon as it has loaded.
    let prefilled = false;

    watch(
        () => [open, caddyQuery.data] as const,
        ([isOpen, caddy]) => {
            if (!isOpen) {
                prefilled = false;

                return;
            }

            if (prefilled || !caddy) return;

            prefilled = true;
            image = caddy.image || DEFAULT_IMAGE;
            caddyfile = caddy.caddyfile ?? "";
            deployMutation.reset();
        },
    );

    const unchanged = $derived(
        !!caddyQuery.data?.deployed &&
            image.trim() === caddyQuery.data.image &&
            caddyfile.trim() === (caddyQuery.data.caddyfile ?? ""),
    );

    const canSubmit = $derived(
        image.trim().length > 0 &&
            !unchanged &&
            caddyQuery.isSuccess &&
            !deployMutation.isPending,
    );

    function submit(event: SubmitEvent) {
        event.preventDefault();

        if (!canSubmit) return;

        deployMutation.mutate({ clusterId, image, caddyfile });
    }
</script>

<Dialog bind:open>
    <DialogContent class="sm:max-w-2xl">
        <DialogHeader>
            <DialogTitle>Configure Caddy</DialogTitle>
            <DialogDescription>
                Rolls out Caddy to every machine, one at a time. Each
                machine's ingress restarts briefly while its container
                is replaced.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel class="space-y-4">
            {#if deployMutation.error}
                <Alert variant="error">
                    <Info aria-hidden="true" />
                    <AlertDescription>
                        {deployMutation.error.message}
                    </AlertDescription>
                </Alert>
            {:else if caddyQuery.isError}
                <Alert variant="error">
                    <Info aria-hidden="true" />
                    <AlertDescription>
                        Unable to load the current Caddy settings: {caddyQuery
                            .error.message}
                    </AlertDescription>
                </Alert>
            {/if}

            <form
                id="caddy-form"
                method="POST"
                class="space-y-4"
                onsubmit={submit}
                aria-busy={deployMutation.isPending}
            >
                <Field>
                    <Label for="caddy-image" required>Image</Label>
                    <Input
                        id="caddy-image"
                        bind:value={image}
                        maxlength={512}
                        spellcheck={false}
                        autocomplete="off"
                        placeholder={DEFAULT_IMAGE}
                        class="font-mono"
                    />
                    <FieldDescription>
                        A custom build adds modules, like a DNS
                        provider for wildcard certificates. Like the
                        official image, it must include curl and load
                        /etc/caddy/Caddyfile. Pin a version tag:
                        redeploying the same tag does not pull a newer
                        build.
                    </FieldDescription>
                </Field>

                <Field>
                    <Label for="caddy-caddyfile">
                        Global Caddyfile
                    </Label>
                    <Textarea
                        id="caddy-caddyfile"
                        bind:value={caddyfile}
                        rows={12}
                        maxlength={262144}
                        spellcheck={false}
                        placeholder={"{\n\temail ops@example.com\n}\n\n(security_headers) {\n\theader Strict-Transport-Security max-age=31536000\n}"}
                        class="font-mono text-[13px]"
                    />
                    <FieldDescription>
                        Prepended to the generated config: global
                        options, snippets services can import, and
                        routes to services Uncloud does not manage.
                        Leave empty to remove it. Read secrets with
                        {"{env.NAME}"} instead of pasting them. An invalid
                        config keeps Caddy on its previous one, and the
                        error shows on the cluster page. With monitoring,
                        Stoat adds a
                        <code>metrics</code>
                        global option for HTTP metrics unless you set one
                        yourself.
                    </FieldDescription>
                </Field>
            </form>
        </DialogPanel>

        <DialogFooter>
            <Button
                variant="outline"
                disabled={deployMutation.isPending}
                onclick={() => {
                    open = false;
                }}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="caddy-form"
                loading={deployMutation.isPending}
                disabled={!canSubmit}
            >
                Deploy Caddy
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
