<script lang="ts">
    import OrganizationApiKeys from "$lib/components/settings/organization-api-keys.svelte";
    import OrganizationDanger from "$lib/components/settings/organization-danger.svelte";
    import OrganizationGeneral from "$lib/components/settings/organization-general.svelte";
    import OrganizationMembers from "$lib/components/settings/organization-members.svelte";
    import PasswordSettings from "$lib/components/settings/password-settings.svelte";
    import ProfileSettings from "$lib/components/settings/profile-settings.svelte";
    import SettingsNav, {
        sections,
        type SettingsNavGroup,
    } from "$lib/components/settings/settings-nav.svelte";
    import KeyRound from "@lucide/svelte/icons/key-round";
    import Lock from "@lucide/svelte/icons/lock";
    import Settings from "@lucide/svelte/icons/settings-2";
    import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
    import User from "@lucide/svelte/icons/user";
    import Users from "@lucide/svelte/icons/users";
    import { parseAsStringLiteral, useQueryState } from "nuqs-svelte";

    let { data } = $props();

    const organization = $derived(
        data.organizations.find(
            (item) => item.id === data.activeOrganizationId,
        ),
    );

    const isOwner = $derived(
        organization?.role
            .split(",")
            .some((role) => role.trim() === "owner") ?? false,
    );

    const groups = $derived<SettingsNavGroup[]>([
        {
            label: "Account",
            items: [
                { value: "profile", label: "Profile", icon: User },
                { value: "security", label: "Security", icon: Lock },
            ],
        },
        ...(organization
            ? [
                  {
                      label: organization.name,
                      items: [
                          {
                              value: "organization" as const,
                              label: "General",
                              icon: Settings,
                          },
                          {
                              value: "members" as const,
                              label: "Members",
                              icon: Users,
                          },
                          ...(isOwner
                              ? [
                                    {
                                        value: "api-keys" as const,
                                        label: "API keys",
                                        icon: KeyRound,
                                    },
                                    {
                                        value: "danger" as const,
                                        label: "Danger zone",
                                        icon: TriangleAlert,
                                        variant:
                                            "destructive-ghost" as const,
                                    },
                                ]
                              : []),
                      ],
                  },
              ]
            : []),
    ]);

    const section = useQueryState(
        "section",
        parseAsStringLiteral(sections).withOptions({
            shallow: true,
            scroll: false,
        }),
    );

    // Fall back to Profile when the section is unknown or not visible to
    // this user, e.g. a non-owner opening ?section=api-keys.
    const active = $derived(
        groups
            .flatMap((group) => group.items)
            .find((item) => item.value === section.current)?.value ??
            "profile",
    );
</script>

<svelte:head><title>Settings / Stoat</title></svelte:head>
<div class="flex w-full flex-col gap-6 pt-6">
    <div class="space-y-1">
        <h1 class="text-2xl font-semibold">Settings</h1>
        <p class="text-sm text-muted-foreground">
            Manage your account and {organization?.name ??
                "your organization"}.
        </p>
    </div>
    <div
        class="grid gap-6 xl:grid-cols-4 xl:grid-rows-[auto_minmax(0,1fr)] xl:gap-y-0"
    >
        <SettingsNav
            {groups}
            {active}
            onselect={(value) => void section.set(value)}
        />
        {#if active === "profile"}
            <ProfileSettings user={data.user} />
        {:else if active === "security"}
            <PasswordSettings />
        {:else if organization}
            {#if active === "organization"}
                <OrganizationGeneral
                    {organization}
                    canManage={isOwner}
                />
            {:else if active === "members"}
                <OrganizationMembers
                    organizationId={organization.id}
                    currentUserEmail={data.user.email}
                    canManage={isOwner}
                />
            {:else if active === "api-keys"}
                <OrganizationApiKeys {organization} />
            {:else if active === "danger"}
                <OrganizationDanger {organization} />
            {/if}
        {/if}
    </div>
</div>
