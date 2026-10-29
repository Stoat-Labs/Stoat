<script lang="ts">
    import ConfirmDialog from "$lib/components/settings/confirm-dialog.svelte";
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
        FieldError,
    } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { orpc, queryClient } from "$lib/api/orpc";
    import { isClusterDomain } from "@stoat/workflows/ingress";
    import Info from "@lucide/svelte/icons/info";
    import {
        createMutation,
        createQuery,
    } from "@tanstack/svelte-query";
    import { parseAsString, useQueryState } from "nuqs-svelte";
    import { watch } from "runed";

    let { clusterId }: { clusterId: string } = $props();

    const dialog = useQueryState(
        "dialog",
        parseAsString.withOptions({ shallow: true, scroll: false }),
    );

    // The release confirmation opens on top of this dialog.
    const open = $derived(
        dialog.current === "domain" ||
            dialog.current === "release-domain",
    );

    let name = $state("");

    const domainQuery = createQuery(() =>
        orpc.cluster.getDomain.queryOptions({ input: { clusterId } }),
    );

    const current = $derived(domainQuery.data);

    async function close(changedClusterId: string) {
        await queryClient.invalidateQueries({
            queryKey: orpc.cluster.getDomain.queryKey({
                input: { clusterId: changedClusterId },
            }),
        });

        if (clusterId === changedClusterId) void dialog.set(null);
    }

    const setMutation = createMutation(() =>
        orpc.cluster.setDomain.mutationOptions({
            onSuccess: (_data, variables) =>
                close(variables.clusterId),
        }),
    );

    const clearMutation = createMutation(() =>
        orpc.cluster.clearDomain.mutationOptions({
            onSuccess: (_data, variables) =>
                close(variables.clusterId),
        }),
    );

    // Prefill once per opening, as soon as the domain has loaded.
    let prefilled = false;

    watch(
        () => [open, current] as const,
        ([isOpen, domain]) => {
            if (!isOpen) {
                prefilled = false;

                return;
            }

            if (prefilled || !domain) return;

            prefilled = true;
            // A uncld.dev name belongs to Uncloud DNS; the field is for the user's own.
            name = domain.reserved ? "" : (domain.domain ?? "");
            setMutation.reset();
        },
    );

    watch(
        () => dialog.current,
        (value) => {
            if (value === "remove-domain") clearMutation.reset();
        },
    );

    const trimmed = $derived(
        name.trim().toLowerCase().replace(/\.$/u, ""),
    );

    const valid = $derived(isClusterDomain(trimmed));

    const record = $derived(
        `*.${valid ? trimmed : "apps.example.com"}`,
    );

    const canSubmit = $derived(
        valid &&
            !!current &&
            trimmed !== current.domain &&
            !setMutation.isPending,
    );

    const errorMessage = $derived(setMutation.error?.message ?? "");

    function save(release = false) {
        if (!canSubmit || !current) return;

        // Replacing a uncld.dev domain releases it, which needs its own confirmation.
        if (current.reserved && !release) {
            void dialog.set("release-domain");

            return;
        }

        setMutation.mutate({ clusterId, domain: trimmed, release });
    }

    function submit(event: SubmitEvent) {
        event.preventDefault();
        save();
    }
</script>

<Dialog
    bind:open={
        () => open,
        (value) => {
            if (!value && open) void dialog.set(null);
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>Cluster domain</DialogTitle>
            <DialogDescription>
                Services published without a hostname get one under
                this domain. Existing services keep theirs until
                they're redeployed.
            </DialogDescription>
        </DialogHeader>

        <DialogPanel>
            {#if errorMessage && dialog.current === "domain"}
                <Alert variant="error" class="mb-4">
                    <Info aria-hidden="true" />
                    <AlertDescription>
                        {errorMessage}
                    </AlertDescription>
                </Alert>
            {/if}

            <form
                id="cluster-domain-form"
                method="POST"
                onsubmit={submit}
                aria-busy={setMutation.isPending}
            >
                <Field>
                    <Label for="cluster-domain" required>
                        Domain
                    </Label>
                    <Input
                        id="cluster-domain"
                        bind:value={name}
                        placeholder="apps.example.com"
                        maxlength={253}
                        autocomplete="off"
                        spellcheck={false}
                        aria-invalid={trimmed && !valid
                            ? true
                            : undefined}
                    />
                    {#if trimmed && !valid}
                        <FieldError>
                            Enter a domain such as apps.example.com.
                        </FieldError>
                    {/if}
                    <FieldDescription>
                        Point the wildcard record <code>
                            {record}
                        </code>
                        at the machines running Caddy. Stoat doesn't change
                        your DNS records.
                    </FieldDescription>
                </Field>
            </form>
        </DialogPanel>

        <DialogFooter>
            <Button
                variant="outline"
                disabled={setMutation.isPending}
                onclick={() => void dialog.set(null)}
            >
                Cancel
            </Button>
            <Button
                type="submit"
                form="cluster-domain-form"
                loading={setMutation.isPending}
                disabled={!canSubmit}
            >
                Save domain
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={
        () => dialog.current === "release-domain",
        (value) => {
            if (!value && dialog.current === "release-domain")
                void dialog.set("domain");
        }
    }
    title={`Release ${current?.domain ?? "the uncld.dev domain"}?`}
    description="Uncloud DNS can't give this name back, and Caddy stops updating its DNS records. Services keep their hostnames until they're redeployed."
    confirmLabel="Release and save"
    pending={setMutation.isPending}
    error={errorMessage}
    onconfirm={() => save(true)}
/>

<ConfirmDialog
    bind:open={
        () => dialog.current === "remove-domain",
        (value) => {
            if (!value && dialog.current === "remove-domain")
                void dialog.set(null);
        }
    }
    title="Remove the cluster domain?"
    description={current?.reserved
        ? `This releases ${current.domain}, which Uncloud DNS can't give back. Services keep their hostnames until they're redeployed.`
        : "Services published without a hostname stop getting one on their next deploy. Your DNS records aren't changed."}
    confirmLabel="Remove domain"
    pending={clearMutation.isPending}
    error={clearMutation.error?.message ?? ""}
    onconfirm={() =>
        clearMutation.mutate({
            clusterId,
            release: current?.reserved ?? false,
        })}
/>
