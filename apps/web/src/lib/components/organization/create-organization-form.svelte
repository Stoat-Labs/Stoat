<script lang="ts">
    import { authClient } from "$lib/api/auth-client";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import { Input } from "$lib/components/ui/input";
    import { Label } from "$lib/components/ui/label";

    // The submit button lives with the caller (a dialog footer or the setup page) and targets
    // this form through `formId`.
    let {
        formId,
        pending = $bindable(false),
        oncreated,
    }: {
        formId: string;
        pending?: boolean;
        oncreated: () => void | Promise<void>;
    } = $props();

    let name = $state("");

    let slug = $state("");

    let slugTouched = $state(false);

    let logoUrl = $state("");

    let error = $state("");

    function slugify(value: string) {
        return value
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .replace(/-{2,}/g, "-");
    }

    function onNameInput(value: string) {
        name = value;

        if (!slugTouched) slug = slugify(value);
    }

    async function createOrganization(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";

        try {
            const result = await authClient.organization.create({
                name: name.trim(),
                slug: slug.trim(),
                logo: logoUrl.trim() || undefined,
                keepCurrentActiveOrganization: false,
            });

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to create organization.";

                return;
            }

            await oncreated();
        } catch {
            error = "Unable to connect. Try again.";
        } finally {
            pending = false;
        }
    }
</script>

{#if error}
    <Alert variant="error" class="mb-4">
        <AlertDescription>{error}</AlertDescription>
    </Alert>
{/if}
<form
    id={formId}
    onsubmit={createOrganization}
    class="space-y-4"
    aria-busy={pending}
>
    <Field>
        <Label for="org-name" required>Name</Label>
        <Input
            id="org-name"
            value={name}
            oninput={(event) =>
                onNameInput(event.currentTarget.value)}
            placeholder="Acme Corp"
            required
            maxlength={100}
            pattern=".*\S.*"
            disabled={pending}
        />
    </Field>
    <Field>
        <Label for="org-slug" required>Slug</Label>
        <Input
            id="org-slug"
            bind:value={slug}
            oninput={() => {
                slugTouched = true;
            }}
            placeholder="acme-corp"
            required
            minlength={2}
            maxlength={80}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            aria-describedby="org-slug-help"
            disabled={pending}
        />
        <FieldDescription id="org-slug-help">
            This will be used in your organization URL.
        </FieldDescription>
    </Field>
    <Field>
        <Label for="org-logo">Logo URL</Label>
        <Input
            id="org-logo"
            bind:value={logoUrl}
            type="url"
            placeholder="https://…"
            disabled={pending}
        />
        <FieldDescription>
            A direct link to your organization's logo.
        </FieldDescription>
    </Field>
</form>
