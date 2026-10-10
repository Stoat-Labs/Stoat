<script lang="ts">
    import { authClient } from "$lib/api/auth-client";
    import AuthForm from "$lib/components/auth/auth-form.svelte";
    import AuthShell from "$lib/components/auth/auth-shell.svelte";
    import CreateClusterForm from "$lib/components/clusters/create-cluster-form.svelte";
    import InitializeClusterForm from "$lib/components/clusters/initialize-cluster-form.svelte";
    import CreateOrganizationForm from "$lib/components/organization/create-organization-form.svelte";
    import { Button } from "$lib/components/ui/button";
    import { Label } from "$lib/components/ui/label";
    import { Switch } from "$lib/components/ui/switch";
    import {
        parseAsString,
        parseAsStringLiteral,
        useQueryState,
    } from "nuqs-svelte";

    let { data } = $props();

    const urlOptions = {
        history: "replace",
        shallow: true,
        scroll: false,
    } as const;

    // The cluster step is optional, so its progress lives in the URL rather than the database.
    const clusterStep = useQueryState(
        "step",
        parseAsStringLiteral(["cluster", "done"])
            .withDefault("cluster")
            .withOptions(urlOptions),
    );

    const clusterId = useQueryState(
        "cluster",
        parseAsString.withOptions(urlOptions),
    );

    const deploymentId = useQueryState(
        "deployment",
        parseAsString.withOptions(urlOptions),
    );

    // Only the instance admin creates the account; everyone else starts at the organization.
    const eyebrow = $derived(
        data.isAdmin
            ? `Step ${{ account: 1, organization: 2, cluster: 3 }[data.step]} of 3`
            : `Step ${{ account: 1, organization: 1, cluster: 2 }[data.step]} of 2`,
    );

    let signupsEnabled = $state(false);

    let pending = $state(false);

    let ready = $state(false);

    let canSubmit = $state(false);

    async function organizationCreated() {
        // Sign-ups are closed by default; only record a change. If this fails the done step
        // shows the saved value, and /admin/settings can change it later.
        if (data.isAdmin && signupsEnabled) {
            const body = new FormData();
            body.set("signupsEnabled", "true");
            await fetch("/setup?/signups", {
                method: "POST",
                body,
                headers: { accept: "application/json" },
            });
        }

        // A full navigation picks up the new organization in the session.
        window.location.assign("/setup?step=cluster");
    }

    async function signOut() {
        await authClient.signOut();
        window.location.assign("/login");
    }

    function skip() {
        void clusterStep.set("done");
    }
</script>

<svelte:head>
    <title>Set up Stoat / Stoat</title>
</svelte:head>

{#if data.step === "account"}
    <AuthForm mode="setup" {eyebrow} />
{:else if data.step === "organization"}
    <AuthShell
        title="Create your organization"
        description="Projects, clusters and members all belong to an organization."
        {eyebrow}
    >
        <CreateOrganizationForm
            formId="setup-organization-form"
            bind:pending
            oncreated={organizationCreated}
        />
        {#if data.isAdmin}
            <div class="flex items-center justify-between gap-4">
                <div class="space-y-1">
                    <Label for="signups-enabled">
                        Allow user signups
                    </Label>
                    <p
                        id="signups-description"
                        class="text-sm text-muted-foreground"
                    >
                        Off means people join only through an
                        invitation. You can change this later in
                        instance settings.
                    </p>
                </div>
                <Switch
                    id="signups-enabled"
                    bind:checked={signupsEnabled}
                    disabled={pending}
                    aria-describedby="signups-description"
                />
            </div>
        {/if}
        <Button
            type="submit"
            form="setup-organization-form"
            class="mt-3 w-full"
            size="sm"
            loading={pending}
        >
            Create organization
        </Button>
        {#snippet footer()}
            {#if !data.isAdmin}
                <p class="text-center text-sm text-muted-foreground">
                    Waiting for an invitation instead?
                    <button
                        type="button"
                        class="ml-1 underline underline-offset-4 hover:text-primary"
                        onclick={signOut}
                    >
                        Log out
                    </button>
                </p>
            {/if}
        {/snippet}
    </AuthShell>
{:else if clusterStep.current === "done"}
    <AuthShell
        title="You're all set"
        description={deploymentId.current
            ? "Monitoring is deploying to your cluster. You can follow it from the deployment page."
            : clusterId.current
              ? "Your cluster is connected. Set up monitoring any time from its page."
              : "Your workspace is ready. Connect a cluster any time from the Clusters page."}
    >
        {#if data.isAdmin}
            <p class="text-sm text-muted-foreground">
                Public sign-ups are {data.signupsEnabled
                    ? "open"
                    : "closed"}. Change it in instance settings.
            </p>
        {/if}
        <div class="flex flex-col gap-2">
            <Button href="/" class="w-full" size="sm">
                Go to dashboard
            </Button>
            {#if deploymentId.current}
                <Button
                    href="/deployments/{deploymentId.current}"
                    variant="outline"
                    class="w-full"
                    size="sm"
                >
                    View monitoring deployment
                </Button>
            {/if}
        </div>
    </AuthShell>
{:else if !clusterId.current}
    <AuthShell
        title="Connect a cluster"
        description="Point Stoat at the sidecar running on your Uncloud cluster. You can also do this later."
        {eyebrow}
        wide
    >
        <CreateClusterForm
            formId="setup-cluster-form"
            bind:pending
            bind:canSubmit
            oncreated={(id) => void clusterId.set(id)}
        />
        <p class="text-sm text-muted-foreground">
            No sidecar yet? Deploy it with
            <span class="font-mono">uc deploy</span>
            as the README shows.
        </p>
        <div class="flex justify-end gap-2">
            <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onclick={skip}
            >
                Skip for now
            </Button>
            <Button
                type="submit"
                form="setup-cluster-form"
                size="sm"
                loading={pending}
                disabled={!canSubmit}
            >
                Connect cluster
            </Button>
        </div>
    </AuthShell>
{:else}
    <AuthShell
        title="Set up monitoring"
        description="Deploy the internal monitoring stack for metrics and logs. No public ports or ingress routes are created."
        {eyebrow}
        wide
    >
        <InitializeClusterForm
            formId="setup-monitoring-form"
            clusterId={clusterId.current}
            bind:pending
            bind:ready
            bind:canSubmit
            oninitialized={(id) => {
                void deploymentId.set(id);
                void clusterStep.set("done");
            }}
        />
        <div class="flex justify-end gap-2">
            <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onclick={skip}
            >
                Skip for now
            </Button>
            {#if ready}
                <Button
                    type="submit"
                    form="setup-monitoring-form"
                    size="sm"
                    loading={pending}
                    disabled={!canSubmit}
                >
                    Initialize monitoring
                </Button>
            {/if}
        </div>
    </AuthShell>
{/if}
