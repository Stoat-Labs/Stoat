<script lang="ts">
    import { page } from "$app/state";
    import { authClient } from "$lib/api/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Badge } from "$lib/components/ui/badge";
    import {
        Button,
        buttonVariants,
    } from "$lib/components/ui/button";
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
    import {
        Menu,
        MenuItem,
        MenuPopup,
        MenuTrigger,
    } from "$lib/components/ui/menu";
    import { Separator } from "$lib/components/ui/separator";
    import { Skeleton } from "$lib/components/ui/skeleton";
    import Ellipsis from "@lucide/svelte/icons/ellipsis";
    import Link from "@lucide/svelte/icons/link";
    import Mail from "@lucide/svelte/icons/mail";
    import Plus from "@lucide/svelte/icons/plus";
    import User from "@lucide/svelte/icons/user";
    import UserMinus from "@lucide/svelte/icons/user-minus";
    import X from "@lucide/svelte/icons/x";
    import { createQuery } from "@tanstack/svelte-query";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import ConfirmDialog from "./confirm-dialog.svelte";
    import SettingsSection from "./settings-section.svelte";

    let {
        organizationId,
        currentUserEmail,
        canManage,
    }: {
        organizationId: string;
        currentUserEmail: string;
        canManage: boolean;
    } = $props();

    const roles = [
        { value: "member", label: "Member" },
        { value: "admin", label: "Admin" },
    ];

    const membersQuery = createQuery(() => ({
        queryKey: ["organization-members", organizationId],
        queryFn: async () => {
            const result = await authClient.organization.listMembers({
                query: { organizationId },
            });

            if (result.error)
                throw new Error(
                    result.error.message ?? "Unable to load members.",
                );

            return result.data.members;
        },
    }));

    const invitationsQuery = createQuery(() => ({
        queryKey: ["organization-invitations", organizationId],
        queryFn: async () => {
            const result =
                await authClient.organization.listInvitations({
                    query: { organizationId },
                });

            if (result.error)
                throw new Error(
                    result.error.message ??
                        "Unable to load invitations.",
                );

            return result.data.filter(
                (invitation) => invitation.status === "pending",
            );
        },
        enabled: canManage,
    }));

    let inviteOpen = $state(false);

    let email = $state("");

    let role = $state("member");

    let inviting = $state(false);

    let inviteError = $state("");

    let inviteId = $state("");

    let actionError = $state("");

    let copiedId = $state("");

    let removeTarget = $state<{ id: string; name: string } | null>(
        null,
    );

    let removeOpen = $state(false);

    let removing = $state(false);

    let removeError = $state("");

    const error = $derived(
        membersQuery.error?.message ??
            invitationsQuery.error?.message ??
            actionError,
    );

    function openInvite() {
        email = "";
        role = "member";
        inviteId = "";
        inviteError = "";
        inviteOpen = true;
    }

    async function invite(event: SubmitEvent) {
        event.preventDefault();

        if (inviting) return;
        inviting = true;
        inviteError = "";

        try {
            const result = await authClient.organization.inviteMember(
                {
                    email: email.trim(),
                    role: role === "admin" ? "admin" : "member",
                    organizationId,
                },
            );

            if (result.error) {
                inviteError =
                    result.error.message ??
                    "Unable to invite that person.";

                return;
            }

            inviteId = result.data.id;
            await invitationsQuery.refetch();
        } finally {
            inviting = false;
        }
    }

    async function copyLink(invitationId: string) {
        await navigator.clipboard.writeText(
            `${page.url.origin}/invite/${invitationId}`,
        );
        copiedId = invitationId;
    }

    async function cancelInvitation(invitationId: string) {
        actionError = "";

        const result = await authClient.organization.cancelInvitation(
            {
                invitationId,
            },
        );

        if (result.error)
            actionError =
                result.error.message ??
                "Unable to cancel the invitation.";
        else await invitationsQuery.refetch();
    }

    function askRemove(member: {
        id: string;
        user: { name: string };
    }) {
        removeTarget = { id: member.id, name: member.user.name };
        removeError = "";
        removeOpen = true;
    }

    async function remove() {
        if (!removeTarget || removing) return;
        removing = true;
        removeError = "";

        try {
            const result = await authClient.organization.removeMember(
                {
                    memberIdOrEmail: removeTarget.id,
                    organizationId,
                },
            );

            if (result.error) {
                removeError =
                    result.error.message ??
                    "Unable to remove the member.";

                return;
            }

            removeOpen = false;
            await membersQuery.refetch();
        } finally {
            removing = false;
        }
    }
</script>

<SettingsSection
    title="Members"
    description="People with access to this organization."
    count={membersQuery.data
        ? `${membersQuery.data.length} ${membersQuery.data.length === 1 ? "member" : "members"}`
        : undefined}
    panelClass="p-0"
>
    {#snippet actions()}
        {#if canManage}
            <Button onclick={openInvite}>
                <Plus class="size-4" aria-hidden="true" />
                Invite member
            </Button>
        {/if}
    {/snippet}
    {#if error}
        <Alert variant="error" class="m-3 w-auto">
            <AlertDescription>{error}</AlertDescription>
        </Alert>
    {/if}
    {#if membersQuery.isPending}
        <Skeleton
            loading
            count={2}
            count-gap={1}
            loading-label="Loading members"
        >
            <div
                class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
            >
                <span
                    class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                >
                    <User class="size-5" aria-hidden="true" />
                </span>
                <div class="min-w-0">
                    <h3
                        class="truncate text-sm font-medium leading-5"
                    >
                        Member name
                    </h3>
                    <p
                        class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                    >
                        member@example.com
                    </p>
                </div>
                <Badge variant="secondary">Member</Badge>
            </div>
        </Skeleton>
    {:else if membersQuery.data}
        <ul>
            {#each invitationsQuery.data ?? [] as invitation, index (invitation.id)}
                <li class="min-w-0">
                    {#if index > 0}<Separator />{/if}
                    <div
                        class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                    >
                        <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                        >
                            <Mail class="size-5" aria-hidden="true" />
                        </span>
                        <div class="min-w-0">
                            <h3
                                class="truncate text-sm font-medium leading-5"
                                title={invitation.email}
                            >
                                {invitation.email}
                            </h3>
                            <p
                                class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                aria-live="polite"
                            >
                                {copiedId === invitation.id
                                    ? "Invite link copied"
                                    : `Invited as ${invitation.role} · expires ${new Date(
                                          invitation.expiresAt,
                                      ).toLocaleDateString()}`}
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <Badge variant="warning">Pending</Badge>
                            <Menu>
                                <MenuTrigger
                                    class={buttonVariants({
                                        variant: "ghost",
                                        size: "icon-sm",
                                    })}
                                    aria-label={`Actions for invitation to ${invitation.email}`}
                                >
                                    <Ellipsis
                                        class="size-4"
                                        aria-hidden="true"
                                    />
                                </MenuTrigger>
                                <MenuPopup align="end">
                                    <MenuItem
                                        onclick={() =>
                                            copyLink(invitation.id)}
                                    >
                                        <Link aria-hidden="true" />
                                        Copy invite link
                                    </MenuItem>
                                    <MenuItem
                                        variant="destructive"
                                        onclick={() =>
                                            cancelInvitation(
                                                invitation.id,
                                            )}
                                    >
                                        <X aria-hidden="true" />
                                        Cancel invitation
                                    </MenuItem>
                                </MenuPopup>
                            </Menu>
                        </div>
                    </div>
                </li>
            {/each}
            {#each membersQuery.data as member, index (member.id)}
                <li class="min-w-0">
                    {#if index > 0 || invitationsQuery.data?.length}<Separator
                        />{/if}
                    <div
                        class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 p-3"
                    >
                        <span
                            class="flex size-10 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
                        >
                            <User class="size-5" aria-hidden="true" />
                        </span>
                        <div class="min-w-0">
                            <h3
                                class="truncate text-sm font-medium leading-5"
                                title={member.user.name}
                            >
                                {member.user.name}
                                {#if member.user.email === currentUserEmail}
                                    <span
                                        class="font-normal text-muted-foreground"
                                    >
                                        (you)
                                    </span>
                                {/if}
                            </h3>
                            <p
                                class="mt-1 truncate text-xs leading-5 text-muted-foreground"
                                title={member.user.email}
                            >
                                {member.user.email}
                            </p>
                        </div>
                        <div class="flex items-center gap-2">
                            <Badge
                                variant="secondary"
                                class="capitalize"
                            >
                                {member.role}
                            </Badge>
                            {#if canManage && member.user.email !== currentUserEmail}
                                <Menu>
                                    <MenuTrigger
                                        class={buttonVariants({
                                            variant: "ghost",
                                            size: "icon-sm",
                                        })}
                                        aria-label={`Actions for ${member.user.name}`}
                                    >
                                        <Ellipsis
                                            class="size-4"
                                            aria-hidden="true"
                                        />
                                    </MenuTrigger>
                                    <MenuPopup align="end">
                                        <MenuItem
                                            variant="destructive"
                                            onclick={() =>
                                                askRemove(member)}
                                        >
                                            <UserMinus
                                                aria-hidden="true"
                                            />
                                            Remove member
                                        </MenuItem>
                                    </MenuPopup>
                                </Menu>
                            {:else if canManage}
                                <span class="size-8 sm:size-7"></span>
                            {/if}
                        </div>
                    </div>
                </li>
            {/each}
        </ul>
    {/if}
</SettingsSection>

<Dialog bind:open={inviteOpen}>
    <DialogContent>
        <DialogHeader>
            <DialogTitle>
                {inviteId ? "Invite created" : "Invite member"}
            </DialogTitle>
            <DialogDescription>
                {inviteId
                    ? "Share this link with them. They need to sign in with the invited email."
                    : "You'll get an invite link to share. They need to sign in with the invited email."}
            </DialogDescription>
        </DialogHeader>
        {#if inviteId}
            <DialogPanel>
                <code class="block break-all select-all">
                    {page.url.origin}/invite/{inviteId}
                </code>
            </DialogPanel>
            <DialogFooter>
                <Button
                    variant="outline"
                    onclick={() => copyLink(inviteId)}
                >
                    {copiedId === inviteId ? "Copied" : "Copy link"}
                </Button>
                <Button onclick={() => (inviteOpen = false)}>
                    Done
                </Button>
            </DialogFooter>
        {:else}
            <form onsubmit={invite} aria-busy={inviting}>
                <DialogPanel class="space-y-4">
                    <Field>
                        <Label for="invite-email">Email</Label>
                        <Input
                            id="invite-email"
                            type="email"
                            bind:value={email}
                            required
                            placeholder="teammate@example.com"
                            disabled={inviting}
                        />
                    </Field>
                    <Field>
                        <Label for="invite-role">Role</Label>
                        <Select
                            bind:value={role}
                            items={roles}
                            disabled={inviting}
                        >
                            <SelectTrigger
                                id="invite-role"
                                aria-label="Role"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {#each roles as item (item.value)}
                                    <SelectItem
                                        value={item.value}
                                        label={item.label}
                                    >
                                        {item.label}
                                    </SelectItem>
                                {/each}
                            </SelectContent>
                        </Select>
                    </Field>
                    {#if inviteError}
                        <Alert variant="error">
                            <AlertDescription>
                                {inviteError}
                            </AlertDescription>
                        </Alert>
                    {/if}
                </DialogPanel>
                <DialogFooter>
                    <Button
                        type="button"
                        variant="outline"
                        disabled={inviting}
                        onclick={() => (inviteOpen = false)}
                    >
                        Cancel
                    </Button>
                    <Button type="submit" loading={inviting}>
                        Create invite
                    </Button>
                </DialogFooter>
            </form>
        {/if}
    </DialogContent>
</Dialog>

<ConfirmDialog
    bind:open={removeOpen}
    title="Remove member?"
    description="{removeTarget?.name ??
        'This member'} will lose access to this organization."
    confirmLabel="Remove"
    pending={removing}
    error={removeError}
    onconfirm={remove}
/>
