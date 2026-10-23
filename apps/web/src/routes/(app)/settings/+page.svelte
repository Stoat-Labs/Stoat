<script lang="ts">
    import OrganizationApiKeys from "$lib/components/settings/organization-api-keys.svelte";
    import OrganizationDanger from "$lib/components/settings/organization-danger.svelte";
    import OrganizationGeneral from "$lib/components/settings/organization-general.svelte";
    import OrganizationMembers from "$lib/components/settings/organization-members.svelte";
    import PasswordSettings from "$lib/components/settings/password-settings.svelte";
    import PreferencesSettings from "$lib/components/settings/preferences-settings.svelte";
    import ProfileSettings from "$lib/components/settings/profile-settings.svelte";
    import SessionSettings from "$lib/components/settings/session-settings.svelte";
    import {
        activeSection,
        isOwner,
        sectionParser,
        settingsGroups,
    } from "$lib/components/settings/settings-sections";
    import { useQueryState } from "nuqs-svelte";

    let { data } = $props();

    const organization = $derived(
        data.organizations.find(
            (item) => item.id === data.activeOrganizationId,
        ),
    );

    const canManage = $derived(
        organization ? isOwner(organization.role) : false,
    );

    // The settings sidebar links to each section with ?section=.
    const section = useQueryState("section", sectionParser);

    const active = $derived(
        activeSection(settingsGroups(organization), section.current),
    );
</script>

<svelte:head><title>Settings / Stoat</title></svelte:head>
<div class="mx-auto w-full max-w-2xl pt-6 sm:pt-8">
    {#if active === "profile"}
        <ProfileSettings user={data.user} />
    {:else if active === "preferences"}
        <PreferencesSettings />
    {:else if active === "security"}
        <div class="space-y-10">
            <PasswordSettings />
            <SessionSettings />
        </div>
    {:else if organization}
        {#if active === "organization"}
            <OrganizationGeneral {organization} {canManage} />
        {:else if active === "members"}
            <OrganizationMembers
                organizationId={organization.id}
                currentUserEmail={data.user.email}
                {canManage}
            />
        {:else if active === "api-keys"}
            <OrganizationApiKeys {organization} />
        {:else if active === "danger"}
            <OrganizationDanger {organization} />
        {/if}
    {/if}
</div>
