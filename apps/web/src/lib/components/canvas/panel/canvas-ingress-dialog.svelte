<script module lang="ts">
    export type IngressMode = "domain" | "tcp";
</script>

<!-- Railway's "Add Custom Domain" and "Add TCP Proxy" forms, as a dialog over the canvas. -->
<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
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
        addIngressToCompose,
        buildHostSpec,
        buildHttpSpec,
        hostnameError,
        portTextError,
        removeIngressFromCompose,
        type HostIngress,
        type HttpIngress,
        type IngressEntry,
    } from "@stoat/workflows/ingress";
    import Info from "@lucide/svelte/icons/info";
    import { untrack } from "svelte";

    let {
        mode,
        entry,
        entries,
        services,
        compose,
        busy,
        onsubmit,
        onclose,
    }: {
        mode: IngressMode;
        /** The entry being edited; null when adding. */
        entry: HttpIngress | HostIngress | null;
        entries: IngressEntry[];
        services: string[];
        compose: string;
        busy: boolean;
        /** Saves the new Compose text; resolves to the error message, or null once saved. */
        onsubmit: (compose: string) => Promise<string | null>;
        onclose: () => void;
    } = $props();

    // Mounted per use, so the form starts from the props once.
    const editing = untrack(() => entry);

    // Prefilled with resolved values, so `${HOST:-example.com}` shows as example.com.
    const initial = {
        hostname:
            editing?.kind === "http" ? (editing.hostname ?? "") : "",
        port: editing ? String(editing.containerPort) : "",
        publicPort:
            editing?.kind === "host" ? String(editing.hostPort) : "",
        protocol: editing?.kind === "host" ? editing.protocol : "tcp",
    };

    const usesVariables = editing?.raw.includes("$") === true;

    let service = $state(
        untrack(() => editing?.service ?? services[0] ?? ""),
    );

    let hostname = $state(initial.hostname);

    let port = $state(initial.port);

    let publicPort = $state(initial.publicPort);

    let protocol = $state(initial.protocol);

    /** Nothing was changed, so the entry keeps its text as written, variables included. */
    function unchanged() {
        return (
            hostname.trim() === initial.hostname &&
            port.trim() === initial.port &&
            (publicPort.trim() || port.trim()) ===
                (initial.publicPort || initial.port) &&
            protocol === initial.protocol
        );
    }

    let error = $state("");

    const title = $derived(
        mode === "domain"
            ? editing
                ? "Edit Domain"
                : "Add Custom Domain"
            : editing
              ? "Edit TCP Proxy"
              : "Add TCP Proxy",
    );

    const submitLabel = $derived(
        editing
            ? "Update"
            : mode === "domain"
              ? "Add Domain"
              : "Add Proxy",
    );

    // Railway's hint line: what to enter next, or why it can't be added yet.
    const check = $derived.by(() => {
        if (mode === "domain") {
            const name = hostname.trim();

            const issue = name ? hostnameError(name) : null;

            if (issue) return { text: issue, invalid: true };

            if (!port.trim())
                return {
                    text: name
                        ? "Enter the port your app listens on"
                        : "Enter your custom domain",
                    invalid: false,
                };
        } else if (!port.trim())
            return {
                text: "Enter your application port",
                invalid: false,
            };

        for (const text of [port, publicPort]) {
            const value = text.trim();

            const issue = value ? portTextError(value) : null;

            if (issue) return { text: issue, invalid: true };
        }

        if (usesVariables && !unchanged())
            return {
                text: "Saving writes these values in place of the Compose variables.",
                invalid: false,
            };

        return {
            text:
                mode === "domain"
                    ? "Point a DNS A record at your machines. HTTPS is automatic."
                    : `Published on port ${publicPort.trim() || port.trim()} of every machine, bypassing Caddy.`,
            invalid: false,
        };
    });

    const hint = $derived(
        error ? { text: error, invalid: true } : check,
    );

    function otherEntries() {
        return entries.filter(
            (other) =>
                other.kind === "caddy" ||
                other.service !== editing?.service ||
                other.raw !== editing.raw,
        );
    }

    function domainSpec() {
        const name = hostname.trim();
        const portText = port.trim();

        const issue =
            (name ? hostnameError(name) : null) ??
            portTextError(portText);

        if (issue) throw new Error(issue);

        if (
            name &&
            otherEntries().some(
                (other) =>
                    other.kind === "http" &&
                    other.hostname?.toLowerCase() ===
                        name.toLowerCase(),
            )
        )
            throw new Error(`${name} is already published.`);

        if (
            otherEntries().some(
                (other) =>
                    other.kind === "caddy" &&
                    other.service === service,
            )
        )
            throw new Error(
                `${service} uses a custom Caddyfile, so it can't publish domains too.`,
            );

        return buildHttpSpec(
            name || null,
            Number(portText),
            editing?.kind === "http" ? editing.protocol : "https",
        );
    }

    function tcpSpec() {
        const containerText = port.trim();
        const hostText = publicPort.trim() || containerText;

        const issue =
            portTextError(containerText) ?? portTextError(hostText);

        if (issue) throw new Error(issue);

        return buildHostSpec(
            editing?.kind === "host" ? editing.bind : null,
            Number(hostText),
            Number(containerText),
            protocol === "udp" ? "udp" : "tcp",
        );
    }

    async function submit(event: Event) {
        event.preventDefault();
        error = "";

        let next: string;

        try {
            const spec =
                editing && unchanged()
                    ? editing.raw
                    : mode === "domain"
                      ? domainSpec()
                      : tcpSpec();

            if (
                editing &&
                spec === editing.raw &&
                service === editing.service
            ) {
                onclose();

                return;
            }

            if (
                otherEntries().some(
                    (other) =>
                        other.kind !== "caddy" &&
                        other.service === service &&
                        other.raw === spec,
                )
            )
                throw new Error(
                    `${service} already publishes ${spec}.`,
                );

            const base = editing
                ? removeIngressFromCompose(
                      compose,
                      editing.service,
                      editing.raw,
                  )
                : compose;

            next = addIngressToCompose(base, service, spec);
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";

            return;
        }

        const failure = await onsubmit(next);

        if (failure) error = failure;
        else onclose();
    }
</script>

<Dialog
    bind:open={
        () => true,
        (open) => {
            if (!open) onclose();
        }
    }
>
    <DialogContent class="sm:max-w-md">
        <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
            <form
                id="canvas-ingress-form"
                onsubmit={submit}
                oninput={() => (error = "")}
                class="space-y-3"
            >
                {#if services.length > 1}
                    <Field>
                        <Label for="canvas-ingress-service">
                            Service
                        </Label>
                        <Select
                            value={service}
                            items={services.map((name) => ({
                                value: name,
                                label: name,
                            }))}
                            onValueChange={(value) =>
                                (service = value ?? service)}
                        >
                            <SelectTrigger
                                id="canvas-ingress-service"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {#each services as name (name)}
                                    <SelectItem
                                        value={name}
                                        label={name}
                                    />
                                {/each}
                            </SelectContent>
                        </Select>
                    </Field>
                {/if}

                {#if mode === "domain"}
                    <Input
                        bind:value={hostname}
                        placeholder="example.com"
                        aria-label="Domain"
                        autocomplete="off"
                        spellcheck={false}
                        maxlength={253}
                    />
                    <Input
                        bind:value={port}
                        placeholder="Port your app listens on, e.g. 8080"
                        aria-label="Port"
                        inputmode="numeric"
                        autocomplete="off"
                    />
                {:else}
                    <Input
                        bind:value={port}
                        placeholder="5432"
                        aria-label="Application port"
                        inputmode="numeric"
                        autocomplete="off"
                    />
                    <div class="flex gap-3">
                        <Input
                            bind:value={publicPort}
                            placeholder="Public port (same as above)"
                            aria-label="Public port"
                            inputmode="numeric"
                            autocomplete="off"
                        />
                        <Select
                            value={protocol}
                            items={[
                                { value: "tcp", label: "TCP" },
                                { value: "udp", label: "UDP" },
                            ]}
                            onValueChange={(value) =>
                                (protocol = value ?? protocol)}
                        >
                            <SelectTrigger
                                class="w-24 shrink-0"
                                aria-label="Protocol"
                            >
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="tcp" label="TCP" />
                                <SelectItem value="udp" label="UDP" />
                            </SelectContent>
                        </Select>
                    </div>
                {/if}
            </form>
        </DialogPanel>
        <DialogFooter class="items-center sm:justify-between">
            <p
                class={[
                    "flex min-w-0 items-center gap-2 text-sm",
                    hint.invalid
                        ? "text-destructive-foreground"
                        : "text-muted-foreground",
                ]}
                role={hint.invalid ? "alert" : undefined}
            >
                <Info class="size-4 shrink-0" aria-hidden="true" />
                {hint.text}
            </p>
            <div class="flex shrink-0 gap-2">
                <Button variant="outline" onclick={onclose}>
                    Cancel
                </Button>
                <Button
                    type="submit"
                    form="canvas-ingress-form"
                    disabled={busy || !port.trim() || check.invalid}
                >
                    {submitLabel}
                </Button>
            </div>
        </DialogFooter>
    </DialogContent>
</Dialog>
