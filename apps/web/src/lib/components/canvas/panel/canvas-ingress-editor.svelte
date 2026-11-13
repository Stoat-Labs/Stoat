<script module lang="ts">
    export type IngressMode = "domain" | "tcp";
</script>

<!-- Railway's "Add Custom Domain" and "Add TCP Proxy" forms, inline where the entry will appear. -->
<script lang="ts">
    import { Button } from "$lib/components/ui/button";
    import {
        Frame,
        FrameFooter,
        FramePanel,
    } from "$lib/components/ui/frame";
    import { Input } from "$lib/components/ui/input";
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
    } from "@clowder/workflows/ingress";
    import ArrowRight from "phosphor-svelte/lib/ArrowRightIcon";
    import Cable from "phosphor-svelte/lib/PlugsConnectedIcon";
    import Check from "phosphor-svelte/lib/CheckIcon";
    import Copy from "phosphor-svelte/lib/CopyIcon";
    import Globe from "phosphor-svelte/lib/GlobeIcon";
    import { untrack } from "svelte";

    let {
        mode,
        entry,
        entries,
        services,
        compose,
        clusterDomain,
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
        /** The cluster's reserved domain, which resolves to the machines running Caddy. */
        clusterDomain: string | undefined;
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
                    ? dnsRecord
                        ? "Add this record at your DNS host. HTTPS is issued on the first visit."
                        : "Point a DNS A record at your machines. HTTPS is automatic."
                    : `Published on port ${publicPort.trim() || port.trim()} of every machine, bypassing Caddy.`,
            invalid: false,
        };
    });

    // Once the hostname is valid, the record to create: a CNAME to the cluster domain follows the machines.
    const dnsRecord = $derived.by(() => {
        const name = hostname.trim().replace(/\.$/u, "");

        if (
            mode !== "domain" ||
            !clusterDomain ||
            !name ||
            hostnameError(name)
        )
            return null;

        // A zone apex can't hold a CNAME; DNS hosts offer ALIAS or flattening there instead.
        // shortcut: counts labels, so an apex under a co.uk-style suffix shows CNAME; use a public suffix list if that matters.
        const labels = name.replace(/^\*\./u, "").split(".").length;

        return {
            type: labels > 2 ? "CNAME" : "ALIAS",
            name,
            target: clusterDomain,
        };
    });

    let copied = $state(false);

    async function copyTarget(text: string) {
        await navigator.clipboard.writeText(text);
        copied = true;
        setTimeout(() => (copied = false), 1500);
    }

    const hint = $derived(
        error ? { text: error, invalid: true } : check,
    );

    // The footer shows the DNS record unless something more urgent needs saying.
    const showRecord = $derived(
        !!dnsRecord &&
            !hint.invalid &&
            !(usesVariables && !unchanged()),
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

{#snippet field(
    label: string,
    value: string,
    oninput: (value: string) => void,
    placeholder: string,
    numeric: boolean,
    focus: boolean,
)}
    <input
        {value}
        oninput={(event) => oninput(event.currentTarget.value)}
        onkeydown={(event) => {
            if (event.key === "Escape") onclose();
        }}
        {placeholder}
        aria-label={label}
        inputmode={numeric ? "numeric" : undefined}
        maxlength={numeric ? 5 : 253}
        autocomplete="off"
        spellcheck={false}
        class={[
            "min-w-0 bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60",
            numeric ? "w-[6ch] tabular-nums" : "flex-1",
        ]}
        {@attach (node) => {
            if (focus) node.focus();
        }}
    />
{/snippet}

<form
    onsubmit={submit}
    oninput={() => (error = "")}
    aria-label={submitLabel}
    class="motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-top-1 motion-safe:duration-200"
>
    <!-- Inverted frame: the inputs sit in the panel, the record and actions on the surround below. -->
    <Frame>
        <FramePanel class="flex items-center gap-4 px-4 py-3">
            {#if mode === "domain"}
                <Globe
                    class="size-5 shrink-0 text-primary"
                    aria-hidden="true"
                />
            {:else}
                <Cable
                    class="size-5 shrink-0 text-primary"
                    aria-hidden="true"
                />
            {/if}

            <!-- Reads as the address it will publish: https://host → :port. -->
            <div
                class="flex min-w-0 flex-1 items-center gap-2 font-mono text-sm"
            >
                {#if mode === "domain"}
                    <span class="text-muted-foreground select-none">
                        https://
                    </span>
                    {@render field(
                        "Domain",
                        hostname,
                        (value) => (hostname = value),
                        "app.example.com",
                        false,
                        true,
                    )}
                    <span class="text-muted-foreground select-none">
                        :
                    </span>
                    {@render field(
                        "Port",
                        port,
                        (value) => (port = value),
                        "8080",
                        true,
                        false,
                    )}
                {:else}
                    <span class="text-muted-foreground select-none">
                        :
                    </span>
                    {@render field(
                        "Application port",
                        port,
                        (value) => (port = value),
                        "5432",
                        true,
                        true,
                    )}
                    <ArrowRight
                        class="size-3.5 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                    />
                    <span class="text-muted-foreground select-none">
                        *:
                    </span>
                    {@render field(
                        "Public port",
                        publicPort,
                        (value) => (publicPort = value),
                        port.trim() || "same",
                        true,
                        false,
                    )}
                {/if}
            </div>

            {#if mode === "tcp"}
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
                        size="sm"
                        class="w-20 min-w-0 shrink-0"
                        aria-label="Protocol"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="tcp" label="TCP" />
                        <SelectItem value="udp" label="UDP" />
                    </SelectContent>
                </Select>
            {/if}

            {#if services.length > 1}
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
                        size="sm"
                        class="w-auto min-w-0 max-w-40 shrink-0"
                        aria-label="Service"
                    >
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        {#each services as name (name)}
                            <SelectItem value={name} label={name} />
                        {/each}
                    </SelectContent>
                </Select>
            {/if}
        </FramePanel>

        <FrameFooter
            class="flex items-center justify-between gap-4 py-2 pr-1.5 pl-4"
        >
            {#if showRecord && dnsRecord}
                <p
                    class="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground"
                    title="Add this record at your DNS host. HTTPS is issued on the first visit."
                >
                    <span
                        class="shrink-0 font-semibold text-foreground"
                    >
                        {dnsRecord.type}
                    </span>
                    <span class="shrink-0">→</span>
                    <span class="truncate">{dnsRecord.target}</span>
                    <Button
                        size="icon-xs"
                        variant="ghost"
                        aria-label="Copy {dnsRecord.target}"
                        onclick={() =>
                            void copyTarget(dnsRecord.target)}
                    >
                        {#if copied}
                            <Check
                                class="size-3.5 text-success-foreground"
                                aria-hidden="true"
                            />
                        {:else}
                            <Copy
                                class="size-3.5"
                                aria-hidden="true"
                            />
                        {/if}
                    </Button>
                </p>
            {:else}
                <p
                    class={[
                        "min-w-0 text-xs",
                        hint.invalid
                            ? "text-destructive-foreground"
                            : "text-muted-foreground",
                    ]}
                    role={hint.invalid ? "alert" : undefined}
                >
                    {hint.text}
                </p>
            {/if}
            <div class="flex shrink-0 gap-2">
                <Button size="sm" variant="ghost" onclick={onclose}>
                    Cancel
                </Button>
                <Button
                    size="sm"
                    type="submit"
                    disabled={busy || !port.trim() || check.invalid}
                >
                    {submitLabel}
                </Button>
            </div>
        </FrameFooter>
    </Frame>
</form>
