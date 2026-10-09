<script lang="ts">
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
    import { Textarea } from "$lib/components/ui/textarea";

    let {
        id,
        busy,
        provider,
        initial,
        credentialAction = $bindable(),
        credentialType = $bindable(),
        username = $bindable(),
        password = $bindable(),
        privateKey = $bindable(),
        knownHosts = $bindable(),
    }: {
        id: string;
        busy: boolean;
        provider: "forgejo" | "github" | "generic";
        initial: {
            authType: "token" | "oauth";
            hasCredentials: boolean;
        } | null;
        credentialAction: string;
        credentialType: "https" | "ssh";
        username: string;
        password: string;
        privateKey: string;
        knownHosts: string;
    } = $props();

    const credentialOptions = $derived([
        {
            value: "keep",
            label: `Keep current credentials${initial?.hasCredentials ? " (stored)" : " (none stored)"}`,
        },
        { value: "replace", label: "Replace credentials" },
        ...(provider === "generic"
            ? [
                  {
                      value: "clear",
                      label: "Clear credentials (public repositories)",
                  },
              ]
            : []),
    ]);

    const credentialTypeOptions = [
        { value: "https", label: "HTTPS access token" },
        { value: "ssh", label: "SSH private key / known hosts" },
    ];
</script>

{#if initial && initial.authType === "token"}
    <Field>
        <Label for="{id}-credentials">Stored credentials</Label>
        <Select
            value={credentialAction}
            items={credentialOptions}
            disabled={busy}
            onValueChange={(next) => {
                if (next) credentialAction = next;
            }}
        >
            <SelectTrigger id="{id}-credentials" class="min-w-0">
                <SelectValue />
            </SelectTrigger>
            <SelectContent>
                {#each credentialOptions as option (option.value)}
                    <SelectItem
                        value={option.value}
                        label={option.label}
                    />
                {/each}
            </SelectContent>
        </Select>
    </Field>
{/if}
{#if !initial || initial.authType === "oauth" || credentialAction === "replace"}
    <div class="grid gap-4 sm:grid-cols-2">
        {#if provider === "generic"}
            <Field class="sm:col-span-2">
                <Label for="{id}-type">Credential type</Label>
                <Select
                    value={credentialType}
                    items={credentialTypeOptions}
                    disabled={busy}
                    onValueChange={(next) => {
                        if (next)
                            credentialType = next as "https" | "ssh";
                    }}
                >
                    <SelectTrigger id="{id}-type" class="min-w-0">
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {#each credentialTypeOptions as option (option.value)}
                            <SelectItem
                                value={option.value}
                                label={option.label}
                            />
                        {/each}
                    </SelectContent>
                </Select>
            </Field>
        {/if}
        <Field>
            <Label for="{id}-username">
                Username (optional)
            </Label><Input
                id="{id}-username"
                bind:value={username}
                autocomplete="off"
                disabled={busy}
            />
        </Field>
        {#if provider === "generic" && credentialType === "ssh"}
            <Field class="sm:col-span-2">
                <Label for="{id}-key" required>
                    SSH private key
                </Label><Textarea
                    id="{id}-key"
                    bind:value={privateKey}
                    rows={5}
                    autocomplete="off"
                    spellcheck={false}
                    required
                    disabled={busy}
                />
            </Field>
            <Field class="sm:col-span-2">
                <Label for="{id}-hosts" required>
                    Known hosts
                </Label><Textarea
                    id="{id}-hosts"
                    bind:value={knownHosts}
                    rows={3}
                    autocomplete="off"
                    spellcheck={false}
                    required
                    disabled={busy}
                />
            </Field>
            <p class="text-xs text-muted-foreground sm:col-span-2">
                Use an unencrypted key and verified known_hosts
                entries. For custom SSH ports use <code>
                    [hostname]:port
                </code>
                . Existing SSH credentials can also be kept unchanged.
            </p>
        {:else}
            <Field>
                <Label
                    for="{id}-token"
                    required={provider !== "generic"}
                >
                    Access token
                </Label><Input
                    id="{id}-token"
                    type="password"
                    bind:value={password}
                    autocomplete="new-password"
                    required={provider !== "generic"}
                    disabled={busy}
                />
            </Field>
        {/if}
    </div>
    <p class="text-xs text-muted-foreground">
        Stored secrets are never displayed.{provider === "generic"
            ? " Leave the token empty only for public repositories."
            : " The token must permit account and repository discovery."}{initial?.authType ===
        "oauth"
            ? " Saving a token replaces the existing OAuth authorization."
            : ""}
    </p>
{/if}
