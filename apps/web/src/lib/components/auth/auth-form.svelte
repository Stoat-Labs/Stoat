<script lang="ts">
    import { authClient } from "$lib/api/auth-client";
    import { page } from "$app/state";
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Field,
        FieldDescription,
    } from "$lib/components/ui/field";
    import {
        InputGroup,
        InputGroupAddon,
        InputGroupInput,
    } from "$lib/components/ui/input-group";
    import { Label } from "$lib/components/ui/label";
    import AtSign from "@lucide/svelte/icons/at-sign";
    import Lock from "@lucide/svelte/icons/lock";
    import User from "@lucide/svelte/icons/user";
    import { onMount } from "svelte";
    import AuthShell from "./auth-shell.svelte";

    // "setup" is the first account of a fresh install; it becomes the instance admin.
    let {
        mode = "login",
        eyebrow,
    }: { mode?: "login" | "signup" | "setup"; eyebrow?: string } =
        $props();

    const signup = $derived(mode !== "login");

    const copy = $derived(
        {
            login: {
                title: "Welcome back",
                description: "Log into your Stoat workspace.",
                submit: "Log in",
            },
            signup: {
                title: "Create your account",
                description: "Get started with Stoat.",
                submit: "Create account",
            },
            setup: {
                title: "Set up Stoat",
                description:
                    "This account becomes the instance administrator.",
                submit: "Create admin account",
            },
        }[mode],
    );

    // Only same-site paths, so a crafted link can't redirect off-site.
    const next = $derived.by(() => {
        if (mode === "setup") return "/setup";
        const value = page.url.searchParams.get("next");

        return value?.startsWith("/") && !value.startsWith("//")
            ? value
            : "/";
    });

    let name = $state("");

    let email = $state("");

    let password = $state("");

    let ready = $state(false);

    let pending = $state(false);

    let error = $state("");

    onMount(() => {
        ready = true;
    });

    async function submit(event: SubmitEvent) {
        event.preventDefault();

        if (pending) return;
        pending = true;
        error = "";

        try {
            const credentials = { email: email.trim(), password };

            const result = signup
                ? await authClient.signUp.email({
                      ...credentials,
                      name: name.trim(),
                  })
                : await authClient.signIn.email(credentials);

            if (result.error) {
                error =
                    result.error.message ??
                    "Unable to continue. Please try again.";

                return;
            }

            // A full navigation also clears data cached for a previous account.
            window.location.assign(next);
        } catch {
            error =
                "We couldn't connect. Check your connection and try again.";
        } finally {
            pending = false;
        }
    }
</script>

<svelte:head>
    <title>{copy.title} / Stoat</title>
    <meta
        name="description"
        content="Your infrastructure, together. Access your Stoat organization."
    />
</svelte:head>

<AuthShell
    title={copy.title}
    description={copy.description}
    {eyebrow}
>
    {#if mode === "signup" && !page.data.signupsEnabled}
        <Alert>
            <AlertDescription>
                User signups are currently disabled. Contact your
                instance administrator.
            </AlertDescription>
        </Alert>
    {:else}
        <form
            method="POST"
            onsubmit={submit}
            class="flex flex-col gap-2"
            aria-busy={pending}
        >
            {#if signup}
                <Field>
                    <Label for="name" class="sr-only">
                        Full name
                    </Label>
                    <InputGroup>
                        <InputGroupInput
                            id="name"
                            name="name"
                            autocomplete="name"
                            placeholder="Full name"
                            bind:value={name}
                            required
                            maxlength={100}
                            pattern=".*\S.*"
                            disabled={!ready || pending}
                        />
                        <InputGroupAddon align="inline-start">
                            <User aria-hidden="true" />
                        </InputGroupAddon>
                    </InputGroup>
                </Field>
            {/if}
            <Field>
                <Label for="email" class="sr-only">Email</Label>
                <InputGroup>
                    <InputGroupInput
                        id="email"
                        name="email"
                        type="email"
                        autocomplete="email"
                        placeholder="your.email@example.com"
                        bind:value={email}
                        required
                        disabled={!ready || pending}
                    />
                    <InputGroupAddon align="inline-start">
                        <AtSign aria-hidden="true" />
                    </InputGroupAddon>
                </InputGroup>
            </Field>
            <Field>
                <Label for="password" class="sr-only">Password</Label>
                <InputGroup>
                    <InputGroupInput
                        id="password"
                        name="password"
                        type="password"
                        placeholder="Password"
                        autocomplete={signup
                            ? "new-password"
                            : "current-password"}
                        bind:value={password}
                        required
                        minlength={signup ? 8 : undefined}
                        maxlength={128}
                        disabled={!ready || pending}
                        aria-describedby={signup
                            ? "password-hint"
                            : undefined}
                    />
                    <InputGroupAddon align="inline-start">
                        <Lock aria-hidden="true" />
                    </InputGroupAddon>
                </InputGroup>
                {#if signup}<FieldDescription id="password-hint">
                        Use at least 8 characters.
                    </FieldDescription>{/if}
            </Field>
            {#if error}
                <Alert variant="error">
                    <AlertDescription>{error}</AlertDescription>
                </Alert>
            {/if}
            <Button
                type="submit"
                disabled={!ready}
                class="mt-3 w-full"
                size="sm"
                loading={pending}
            >
                {copy.submit}
            </Button>
        </form>
    {/if}
    {#snippet footer()}
        {#if mode === "signup" || (mode === "login" && page.data.signupsEnabled)}
            <p class="text-center text-sm text-muted-foreground">
                {signup
                    ? "Already have an account?"
                    : "New to Stoat?"}
                <a
                    class="ml-1 underline underline-offset-4 hover:text-primary"
                    href="{signup ? '/login' : '/signup'}{next === '/'
                        ? ''
                        : `?next=${encodeURIComponent(next)}`}"
                >
                    {signup ? "Log in" : "Create an account"}
                </a>
            </p>
        {/if}
    {/snippet}
</AuthShell>
