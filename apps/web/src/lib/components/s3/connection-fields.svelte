<script lang="ts">
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";
    import { Switch } from "$lib/components/ui/switch";
    import type { S3ProviderId } from "@stoat/s3/providers";

    let {
        provider,
        editing = false,
        disabled = false,
        endpoint = $bindable(""),
        region = $bindable("us-east-1"),
        forcePathStyle = $bindable(false),
        accountId = $bindable(""),
        accessKey = $bindable(""),
        secretKey = $bindable(""),
        apiToken = $bindable(""),
    }: {
        provider: S3ProviderId;
        // Saved connections keep their secrets when these fields stay blank.
        editing?: boolean;
        disabled?: boolean;
        endpoint?: string;
        region?: string;
        forcePathStyle?: boolean;
        accountId?: string;
        accessKey?: string;
        secretKey?: string;
        apiToken?: string;
    } = $props();

    const keepHint = "Leave blank to keep the saved value";
</script>

{#if provider === "r2"}
    <Field>
        <Label for="s3-account" required>Account ID</Label>
        <Input
            id="s3-account"
            bind:value={accountId}
            placeholder="32-character Cloudflare account ID"
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            {disabled}
        />
    </Field>
    <Field>
        <Label for="s3-token" required={!editing}>API token</Label>
        <Input
            id="s3-token"
            type="password"
            bind:value={apiToken}
            placeholder={editing ? keepHint : "Account API token"}
            autocomplete="new-password"
            aria-describedby="s3-token-description"
            {disabled}
        />
        <FieldDescription id="s3-token-description">
            An account-owned token with Account API Tokens: Edit,
            Workers R2 Storage: Edit, and Account Analytics: Read.
            Stoat uses it to create buckets, a scoped token for each
            one, and to read bucket usage.
        </FieldDescription>
    </Field>
{:else}
    <Field>
        <Label for="s3-endpoint" required>Endpoint</Label>
        <Input
            id="s3-endpoint"
            type="url"
            bind:value={endpoint}
            placeholder="https://s3.example.com"
            autocomplete="off"
            spellcheck="false"
            {disabled}
        />
    </Field>
    {#if provider === "generic"}
        <Field>
            <Label for="s3-region" required>Region</Label>
            <Input
                id="s3-region"
                bind:value={region}
                placeholder="us-east-1"
                autocomplete="off"
                spellcheck="false"
                {disabled}
            />
        </Field>
    {/if}
    <Field>
        <Label for="s3-access" required={!editing}>Access key</Label>
        <Input
            id="s3-access"
            bind:value={accessKey}
            placeholder={editing ? keepHint : "Access key"}
            autocomplete="off"
            spellcheck="false"
            class="font-mono"
            {disabled}
        />
    </Field>
    <Field>
        <Label for="s3-secret" required={!editing}>Secret key</Label>
        <Input
            id="s3-secret"
            type="password"
            bind:value={secretKey}
            placeholder={editing ? keepHint : "Secret key"}
            autocomplete="new-password"
            aria-describedby="s3-secret-description"
            {disabled}
        />
        <FieldDescription id="s3-secret-description">
            {provider === "rustfs"
                ? "An admin user's keys. Stoat creates a service account limited to each bucket."
                : "Keys that can create and delete buckets. Every bucket shares them."}
        </FieldDescription>
    </Field>
    {#if provider === "generic"}
        <div class="flex items-center justify-between gap-4">
            <div>
                <Label for="s3-path-style">
                    Path-style addressing
                </Label>
                <p
                    id="s3-path-style-description"
                    class="text-xs text-muted-foreground"
                >
                    Use when the endpoint has no wildcard DNS for
                    bucket subdomains.
                </p>
            </div>
            <Switch
                id="s3-path-style"
                aria-describedby="s3-path-style-description"
                bind:checked={forcePathStyle}
                {disabled}
            />
        </div>
    {/if}
{/if}
