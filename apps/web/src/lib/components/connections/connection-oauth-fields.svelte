<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import { Field } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import {
        Select,
        SelectContent,
        SelectItem,
        SelectTrigger,
        SelectValue,
    } from "$lib/components/ui/select";
    import type { CreateQueryResult } from "@tanstack/svelte-query";

    let {
        id,
        busy,
        pending,
        provider,
        initial,
        keepOAuth,
        oauthSetupQuery,
        oauthOptions,
        selectedProviderId,
        setupOpen,
        registrationUrl,
        oauthServerUrl,
        setupReady,
        setupError,
        setupStatus,
        copyStatus,
        copyError,
        copying,
        clientId = $bindable(),
        clientSecret = $bindable(),
        oncopy,
        onretry,
        onselectprovider,
        ontogglesetup,
    }: {
        id: string;
        busy: boolean;
        pending: "" | "test" | "save" | "oauth" | "app";
        provider: "forgejo" | "github" | "generic";
        initial: { account: { login: string } | null } | null;
        keepOAuth: boolean;
        oauthSetupQuery: CreateQueryResult<
            { callbackUrl: string },
            Error
        >;
        oauthOptions: { value: string; label: string }[];
        selectedProviderId: string | null;
        setupOpen: boolean;
        registrationUrl: string;
        oauthServerUrl: string;
        setupReady: boolean;
        setupError: string;
        setupStatus: string;
        copyStatus: string;
        copyError: string;
        copying: boolean;
        clientId: string;
        clientSecret: string;
        oncopy: () => void;
        onretry: () => void;
        onselectprovider: (providerId: string) => void;
        ontogglesetup: () => void;
    } = $props();

    const hasConfiguredApps = $derived(oauthOptions.length > 0);
</script>

{#if hasConfiguredApps}
    <Field>
        <Label for="{id}-oauth">Configured OAuth application</Label>
        <Select
            value={selectedProviderId}
            items={oauthOptions}
            disabled={busy}
            onValueChange={(next) => {
                if (!next) return;
                onselectprovider(next);
            }}
        >
            <SelectTrigger id="{id}-oauth" class="min-w-0">
                <SelectValue
                    placeholder="Select an OAuth application"
                />
            </SelectTrigger>
            <SelectContent class="max-w-[calc(100vw-2rem)]">
                {#each oauthOptions as option (option.value)}
                    <SelectItem
                        value={option.value}
                        label={option.label}
                    >
                        <span class="min-w-0 break-all">
                            {option.label}
                        </span>
                    </SelectItem>
                {/each}
            </SelectContent>
        </Select>
    </Field>
{/if}
<div class="space-y-3 rounded-lg border border-border p-4">
    {#if oauthSetupQuery.isError}
        <Alert variant="error">
            <AlertDescription>
                Unable to load the OAuth callback URL. {oauthSetupQuery
                    .error.message}
            </AlertDescription>
        </Alert>
        <Button
            type="button"
            variant="outline"
            size="sm"
            loading={oauthSetupQuery.isFetching}
            disabled={busy || oauthSetupQuery.isFetching}
            onclick={() => {
                onretry();
            }}
        >
            Retry callback URL
        </Button>
    {:else if oauthSetupQuery.isPending}
        <p class="text-sm text-muted-foreground" role="status">
            Loading OAuth callback URL...
        </p>
    {:else}
        <Field>
            <Label for="{id}-callback">OAuth callback URL</Label>
            <InputGroup>
                <InputGroupInput
                    id="{id}-callback"
                    value={oauthSetupQuery.data.callbackUrl}
                    readonly
                    disabled={busy}
                    aria-describedby={copyError
                        ? `${id}-copy-error`
                        : undefined}
                />
                <InputGroupAddon align="inline-end" class="shrink-0">
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        loading={copying}
                        disabled={busy || copying}
                        onclick={oncopy}
                    >
                        Copy URL
                    </Button>
                </InputGroupAddon>
            </InputGroup>
        </Field>
    {/if}
    {#if copyStatus}<p
            class="text-xs text-muted-foreground"
            role="status"
        >
            {copyStatus}
        </p>{/if}
    {#if copyError}<Alert id="{id}-copy-error" variant="error">
            <AlertDescription>
                {copyError}
            </AlertDescription>
        </Alert>{/if}
    <Button
        type="button"
        variant="outline"
        class="h-auto whitespace-normal"
        aria-expanded={setupOpen}
        aria-controls="{id}-oauth-setup"
        disabled={busy}
        onclick={() => {
            ontogglesetup();
        }}
    >
        {setupOpen
            ? "Hide OAuth application setup"
            : "Set up a new OAuth application"}
    </Button>
    <div id="{id}-oauth-setup" hidden={!setupOpen} class="space-y-3">
        {#if setupOpen}
            <p class="text-sm text-muted-foreground">
                Register an OAuth application with your Git provider
                once, using the callback URL above. Then save its
                client credentials here for reuse in this
                organization. No environment editing or restart is
                needed.
            </p>
            {#if provider === "forgejo"}
                <ol
                    class="list-decimal space-y-1 pl-5 text-sm text-muted-foreground"
                >
                    <li>
                        Open your server's applications settings below
                        and find <strong>
                            Create a new OAuth2 Application
                        </strong>
                        .
                    </li>
                    <li>
                        Name it <strong>Stoat</strong>
                        , paste the callback URL as its
                        <strong>Redirect URI</strong>
                        , and enable
                        <strong>Confidential Client</strong>
                        .
                    </li>
                    <li>
                        Create the application, then enter its client
                        ID and secret below. Save, then continue with
                        OAuth to authorize your account.
                    </li>
                </ol>
            {/if}
            {#if registrationUrl}
                <a
                    class="inline-block break-all text-sm underline underline-offset-4"
                    href={registrationUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    Register an OAuth application on {oauthServerUrl} (opens
                    a new tab)
                </a>
            {:else}
                <p class="text-sm text-muted-foreground">
                    Enter a valid HTTPS Git server URL without
                    credentials, a query, or a fragment to register
                    and save an application.
                </p>
            {/if}
            <div class="grid gap-3 sm:grid-cols-2">
                <Field>
                    <Label for="{id}-client-id" required>
                        Client ID
                    </Label><Input
                        id="{id}-client-id"
                        form="{id}-oauth-setup-form"
                        type="password"
                        bind:value={clientId}
                        maxlength={2048}
                        autocomplete="off"
                        spellcheck={false}
                        required
                        disabled={busy}
                    />
                </Field>
                <Field>
                    <Label for="{id}-client-secret" required>
                        Client secret
                    </Label><Input
                        id="{id}-client-secret"
                        form="{id}-oauth-setup-form"
                        type="password"
                        bind:value={clientSecret}
                        maxlength={8192}
                        autocomplete="new-password"
                        spellcheck={false}
                        required
                        disabled={busy}
                    />
                </Field>
            </div>
            <Button
                type="submit"
                form="{id}-oauth-setup-form"
                class="h-auto whitespace-normal"
                loading={pending === "app"}
                disabled={busy || !setupReady}
            >
                Save OAuth application
            </Button>
        {/if}
    </div>
    {#if setupError}<Alert variant="error">
            <AlertDescription>
                OAuth application not saved. {setupError}
            </AlertDescription>
        </Alert>{/if}
    {#if setupStatus}<p
            class="text-sm text-muted-foreground"
            role="status"
        >
            {setupStatus}
        </p>{/if}
</div>
{#if !selectedProviderId}<p class="text-sm text-muted-foreground">
        Set up an OAuth application for this provider and server
        above, or use an access token instead.
    </p>{/if}
{#if keepOAuth}<p class="text-sm text-muted-foreground">
        Currently authorized{initial?.account
            ? ` as ${initial.account.login}`
            : ""}. Save keeps this authorization; reconnect to
        authorize again.
    </p>{/if}
<p class="text-xs text-muted-foreground">
    Continue to the provider to authorize your account. The callback
    verifies your identity and repository access before saving. No
    separate test is needed before authorization.
</p>
