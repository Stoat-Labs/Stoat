<script lang="ts">
    import { authClient } from "$lib/api/auth-client";
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

    let switching = $state(false);

    async function switchAccount() {
        switching = true;

        try {
            await authClient.signOut();
        } finally {
            window.location.assign(
                `/login?next=${encodeURIComponent(`/invite/${data.invitationId}`)}`,
            );
        }
    }

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
                    { cause: result.error.code },
                );

            return result.data;
        },
        retry: false,
    }));

    // Better Auth only shows an invitation to the account with the invited email.
    const wrongAccount = $derived(
        invitation.error?.cause ===
            "YOU_ARE_NOT_THE_RECIPIENT_OF_THE_INVITATION",
    );

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

            // The invitation is accepted now, so a failed switch must not read as a failed join.
            await authClient.organization
                .setActive({
                    organizationId:
                        result.data.invitation.organizationId,
                })
                .catch(() => undefined);
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
                {:else if invitation.isPending}
                    Checking your invitation.
                {/if}
            </CardDescription>
        </CardHeader>
        <CardPanel class="space-y-4">
            {#if invitation.isPending}
                <Skeleton loading label="Loading invitation">
                    <Button class="w-full">Accept invitation</Button>
                </Skeleton>
            {:else if wrongAccount}
                <Alert variant="error">
                    <AlertDescription>
                        This invitation was sent to another email.
                        You're signed in as {data.email}.
                    </AlertDescription>
                </Alert>
                <Button
                    class="w-full"
                    loading={switching}
                    onclick={switchAccount}
                >
                    Sign in with another account
                </Button>
                <Button variant="outline" href="/">Go home</Button>
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
