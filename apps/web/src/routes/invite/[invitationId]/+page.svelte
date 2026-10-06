<script lang="ts">
    import { authClient } from "$lib/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Card,
        CardDescription,
        CardHeader,
        CardPanel,
        CardTitle,
    } from "$lib/components/ui/card";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { createQuery } from "@tanstack/svelte-query";

    let { data } = $props();

    const invitation = createQuery(() => ({
        queryKey: ["invitation", data.invitationId],
        queryFn: async () => {
            const result =
                await authClient.organization.getInvitation({
                    query: { id: data.invitationId },
                });

            if (result.error)
                throw new Error(
                    result.error.message ?? "Invitation not found.",
                );

            return result.data;
        },
        retry: false,
    }));

    let pending = $state(false);

    let error = $state("");

    async function accept() {
        if (pending) return;
        pending = true;
        error = "";

        try {
            const result =
                await authClient.organization.acceptInvitation({
                    invitationId: data.invitationId,
                });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to accept the invitation.";

                return;
            }

            await authClient.organization.setActive({
                organizationId: result.data.invitation.organizationId,
            });
            window.location.assign("/");
        } catch {
            error = "Unable to connect. Try again.";
        } finally {
            pending = false;
        }
    }
</script>

<svelte:head><title>Invitation / Stoat</title></svelte:head>
<main class="mx-auto flex min-h-svh w-full max-w-md items-center p-6">
    <Card class="w-full">
        <CardHeader>
            <CardTitle>Join an organization</CardTitle>
            <CardDescription>
                {#if invitation.data}
                    {invitation.data.inviterEmail} invited you to join
                    {invitation.data.organizationName} as {invitation
                        .data.role}.
                {:else}
                    Checking your invitation.
                {/if}
            </CardDescription>
        </CardHeader>
        <CardPanel class="space-y-4">
            {#if invitation.isPending}
                <Skeleton loading loading-label="Loading invitation">
                    <Button class="w-full">Accept invitation</Button>
                </Skeleton>
            {:else if invitation.error}
                <Alert variant="error">
                    <AlertDescription>
                        {invitation.error.message}
                    </AlertDescription>
                </Alert>
                <Button variant="outline" href="/">Go home</Button>
            {:else}
                {#if error}
                    <Alert variant="error">
                        <AlertDescription>{error}</AlertDescription>
                    </Alert>
                {/if}
                <Button
                    class="w-full"
                    loading={pending}
                    onclick={accept}
                >
                    Accept invitation
                </Button>
            {/if}
        </CardPanel>
    </Card>
</main>
