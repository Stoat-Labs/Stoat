<script lang="ts">
    import { authClient } from "$lib/api/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import { Button } from "$lib/components/ui/button";
    import { Card, CardPanel } from "$lib/components/ui/card";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import { ago } from "$lib/format";
    import { describeUserAgent } from "$lib/user-agent";
    import Monitor from "@lucide/svelte/icons/monitor";
    import { createQuery } from "@tanstack/svelte-query";
    import SettingsSection from "./settings-section.svelte";

    const sessionsQuery = createQuery(() => ({
        queryKey: ["sessions"],
        queryFn: async () => {
            const [list, current] = await Promise.all([
                authClient.listSessions(),
                authClient.getSession(),
            ]);

            if (list.error)
                throw new Error(
                    list.error.message ?? "Unable to load sessions.",
                );

            const currentId = current.data?.session.id;

            // This device first, then the newest sign-ins.
            return list.data
                .map((session) => ({
                    ...session,
                    current: session.id === currentId,
                }))
                .sort(
                    (a, b) =>
                        Number(b.current) - Number(a.current) ||
                        new Date(b.createdAt).getTime() -
                            new Date(a.createdAt).getTime(),
                );
        },
    }));

    let pendingToken = $state("");

    let actionError = $state("");

    const error = $derived(
        sessionsQuery.error?.message ?? actionError,
    );

    const others = $derived(
        sessionsQuery.data?.filter((session) => !session.current)
            .length ?? 0,
    );

    async function revoke(token: string | null) {
        if (pendingToken) return;
        pendingToken = token ?? "others";
        actionError = "";

        try {
            const result = token
                ? await authClient.revokeSession({ token })
                : await authClient.revokeOtherSessions();

            if (result.error) {
                actionError =
                    result.error.message ?? "Unable to sign out.";

                return;
            }

            await sessionsQuery.refetch();
        } finally {
            pendingToken = "";
        }
    }
</script>

<SettingsSection
    title="Sessions"
    description="Devices signed in to your account."
    count={sessionsQuery.data
        ? `${sessionsQuery.data.length} active`
        : undefined}
>
    {#snippet actions()}
        {#if others > 0}
            <Button
                variant="outline"
                loading={pendingToken === "others"}
                disabled={Boolean(pendingToken)}
                onclick={() => revoke(null)}
            >
                Sign out other sessions
            </Button>
        {/if}
    {/snippet}
    {#if error}
        <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}
    {#if sessionsQuery.isPending || sessionsQuery.data}
        <Card>
            <CardPanel class="p-0">
                {#if sessionsQuery.isPending}
                    <Skeleton
                        loading
                        count={2}
                        gap={1}
                        label="Loading sessions"
                    >
                        <div
                            class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                        >
                            <span
                                class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                            >
                                <Monitor
                                    class="size-5"
                                    aria-hidden="true"
                                />
                            </span>
                            <div class="min-w-0">
                                <h3
                                    class="truncate text-sm font-medium leading-5"
                                >
                                    Firefox on Linux
                                </h3>
                                <p
                                    class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                >
                                    127.0.0.1 &middot; Signed in just
                                    now
                                </p>
                            </div>
                            <Badge variant="secondary">
                                This device
                            </Badge>
                        </div>
                    </Skeleton>
                {:else if sessionsQuery.data}
                    <ul>
                        {#each sessionsQuery.data as session, index (session.id)}
                            <li class="min-w-0">
                                {#if index > 0}<Separator />{/if}
                                <div
                                    class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                                >
                                    <span
                                        class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                                    >
                                        <Monitor
                                            class="size-5"
                                            aria-hidden="true"
                                        />
                                    </span>
                                    <div class="min-w-0">
                                        <h3
                                            class="truncate text-sm font-medium leading-5"
                                            title={session.userAgent ??
                                                undefined}
                                        >
                                            {describeUserAgent(
                                                session.userAgent,
                                            )}
                                        </h3>
                                        <p
                                            class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                        >
                                            {#if session.ipAddress}
                                                <span
                                                    class="font-mono"
                                                >
                                                    {session.ipAddress}
                                                </span>
                                                &middot;
                                            {/if}
                                            Signed in {ago(
                                                session.createdAt,
                                                Date.now(),
                                            )}
                                        </p>
                                    </div>
                                    {#if session.current}
                                        <Badge variant="secondary">
                                            This device
                                        </Badge>
                                    {:else}
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            loading={pendingToken ===
                                                session.token}
                                            disabled={Boolean(
                                                pendingToken,
                                            )}
                                            onclick={() =>
                                                revoke(session.token)}
                                        >
                                            Sign out
                                        </Button>
                                    {/if}
                                </div>
                            </li>
                        {/each}
                    </ul>
                {/if}
            </CardPanel>
        </Card>
    {/if}
</SettingsSection>
