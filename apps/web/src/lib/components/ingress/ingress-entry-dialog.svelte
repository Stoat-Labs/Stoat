<script module lang="ts">
    export type DialogKind = "http" | "host" | "caddy";
</script>

<script lang="ts">
    import {
        Alert,
        AlertDescription,
    } from "$lib/components/ui/alert";
    import { Button } from "$lib/components/ui/button";
    import {
        Dialog,
        DialogContent,
        DialogDescription,
        DialogFooter,
        DialogHeader,
        DialogPanel,
        DialogTitle,
    } from "$lib/components/ui/dialog";
    import { Field, FieldError } from "$lib/components/ui/field";
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
    import {
        addIngressToCompose,
        bindError,
        buildHostSpec,
        buildHttpSpec,
        decomposePortSpec,
        hostnameError,
        portTextError,
        removeIngressFromCompose,
        setServiceCaddy,
        type IngressEntry,
    } from "@stoat/workflows/ingress";
    import ArrowRight from "@lucide/svelte/icons/arrow-right";
    import { untrack } from "svelte";

    let {
        kind,
        entry,
        entries,
        services,
        compose,
        onapply,
        onclose,
    }: {
        kind: DialogKind;
        entry: IngressEntry | null;
        entries: IngressEntry[];
        services: string[];
        compose: string;
        onapply: (compose: string) => void;
        onclose: () => void;
    } = $props();

    // The dialog is mounted per use, so the form starts from the props once.
    const editingEntry = untrack(() => entry);

    const editingRaw =
        editingEntry === null || editingEntry.kind === "caddy"
            ? null
            : editingEntry.raw;

    const editingCaddyService =
        editingEntry?.kind === "caddy" ? editingEntry.service : null;

    const isEditing =
        editingRaw !== null || editingCaddyService !== null;

    const rawParts =
        editingRaw === null ? null : decomposePortSpec(editingRaw);

    const rawHttp = rawParts?.kind === "http" ? rawParts : null;

    const rawHost = rawParts?.kind === "host" ? rawParts : null;

    let form = $state(untrack(() => initialForm()));

    let error = $state("");

    const title = $derived(
        isEditing
            ? "Edit ingress"
            : form.kind === "http"
              ? "Add HTTPS ingress"
              : form.kind === "host"
                ? "Add TCP/UDP port"
                : "Add custom Caddy",
    );

    const kindOptions = [
        { value: "http", label: "HTTPS ingress" },
        { value: "host", label: "TCP/UDP host port" },
        { value: "caddy", label: "Custom Caddy" },
    ];

    const serviceOptions = $derived(
        services.map((name) => ({ value: name, label: name })),
    );

    function initialForm() {
        const blank = {
            kind,
            service: services[0] ?? "",
            hostname: "",
            containerPort: "",
            httpProtocol: "https",
            bind: "",
            hostPort: "",
            hostContainerPort: "",
            hostProtocol: "tcp",
            caddy: "",
        };

        if (editingEntry?.kind === "http") {
            return {
                ...blank,
                service: editingEntry.service,
                hostname:
                    rawHttp?.hostname ?? editingEntry.hostname ?? "",
                containerPort:
                    rawHttp?.portText ??
                    String(editingEntry.containerPort),
                httpProtocol:
                    rawHttp?.protocol === "http" ||
                    rawHttp?.protocol === "https"
                        ? rawHttp.protocol
                        : editingEntry.protocol,
            };
        }

        if (editingEntry?.kind === "host") {
            return {
                ...blank,
                service: editingEntry.service,
                bind: rawHost?.bind ?? editingEntry.bind ?? "",
                hostPort:
                    rawHost?.hostPortText ??
                    String(editingEntry.hostPort),
                hostContainerPort:
                    rawHost?.containerPortText ??
                    String(editingEntry.containerPort),
                hostProtocol:
                    rawHost?.protocol === "tcp" ||
                    rawHost?.protocol === "udp"
                        ? rawHost.protocol
                        : editingEntry.protocol,
            };
        }

        if (editingEntry?.kind === "caddy") {
            return {
                ...blank,
                service: editingEntry.service,
                caddy: editingEntry.fileRef ? "" : editingEntry.caddy,
            };
        }

        return blank;
    }

    function serviceHasCaddy(serviceName: string): boolean {
        return entries.some(
            (item) =>
                item.kind === "caddy" && item.service === serviceName,
        );
    }

    function hostnameTaken(hostname: string): boolean {
        return entries.some(
            (item) =>
                item.kind === "http" &&
                item.hostname?.toLowerCase() ===
                    hostname.toLowerCase() &&
                item.raw !== editingRaw,
        );
    }

    function rawTaken(serviceName: string, raw: string): boolean {
        return entries.some(
            (item) =>
                (item.kind === "http" || item.kind === "host") &&
                item.service === serviceName &&
                item.raw === raw &&
                raw !== editingRaw,
        );
    }

    /** The Compose text with `spec` added to the service, replacing the entry being edited. */
    function withPort(spec: string): string {
        const fromService = editingEntry?.service ?? form.service;

        if (editingRaw === spec && fromService === form.service)
            return compose;

        const base =
            editingRaw === null
                ? compose
                : removeIngressFromCompose(
                      compose,
                      fromService,
                      editingRaw,
                  );

        return addIngressToCompose(base, form.service, spec);
    }

    function httpCompose(): string {
        const hostname = form.hostname.trim();
        const portText = form.containerPort.trim();

        const protocol =
            form.httpProtocol === "http" ? "http" : "https";

        const xCaddyConflict = `Service "${form.service}" uses x-caddy and cannot also publish http/https ports. Remove the custom Caddy config first.`;

        if (
            rawHttp !== null &&
            editingRaw !== null &&
            hostname === (rawHttp.hostname ?? "") &&
            portText === rawHttp.portText &&
            protocol === rawHttp.protocol
        ) {
            if (
                form.service !== editingEntry?.service &&
                serviceHasCaddy(form.service)
            )
                throw new Error(xCaddyConflict);

            return withPort(editingRaw);
        }

        if (hostname.includes("$") || portText.includes("$"))
            throw new Error(
                "Changed values with variables can't be validated here. Keep the entry unchanged or edit the Compose file directly.",
            );

        if (hostname !== "") {
            const issue = hostnameError(hostname);

            if (issue !== null) throw new Error(issue);

            if (hostnameTaken(hostname))
                throw new Error(
                    `Hostname "${hostname}" is already published. Hostnames must be unique.`,
                );
        }

        const portIssue = portTextError(portText);

        if (portIssue !== null) throw new Error(portIssue);

        if (serviceHasCaddy(form.service))
            throw new Error(xCaddyConflict);

        const spec = buildHttpSpec(
            hostname === "" ? null : hostname,
            Number(portText),
            protocol,
        );

        if (rawTaken(form.service, spec))
            throw new Error(
                "That publish entry already exists on this service.",
            );

        return withPort(spec);
    }

    function hostCompose(): string {
        const bind = form.bind.trim();
        const hostText = form.hostPort.trim();
        const containerText = form.hostContainerPort.trim();
        const protocol = form.hostProtocol === "udp" ? "udp" : "tcp";

        if (
            rawHost !== null &&
            editingRaw !== null &&
            bind === (rawHost.bind ?? "") &&
            hostText === rawHost.hostPortText &&
            containerText === rawHost.containerPortText &&
            protocol === rawHost.protocol
        )
            return withPort(editingRaw);

        if (
            bind.includes("$") ||
            hostText.includes("$") ||
            containerText.includes("$")
        )
            throw new Error(
                "Changed values with variables can't be validated here. Keep the entry unchanged or edit the Compose file directly.",
            );

        if (bind !== "") {
            const issue = bindError(bind);

            if (issue !== null) throw new Error(issue);
        }

        const hostIssue = portTextError(hostText);

        if (hostIssue !== null)
            throw new Error(`Host port: ${hostIssue}`);

        const containerIssue = portTextError(containerText);

        if (containerIssue !== null)
            throw new Error(`Container port: ${containerIssue}`);

        const spec = buildHostSpec(
            bind === "" ? null : bind,
            Number(hostText),
            Number(containerText),
            protocol,
        );

        if (rawTaken(form.service, spec))
            throw new Error(
                "That publish entry already exists on this service.",
            );

        return withPort(spec);
    }

    function caddyCompose(): string {
        if (form.caddy.trim() === "")
            throw new Error("Paste a Caddyfile first.");

        if (
            editingCaddyService === null &&
            entries.some(
                (item) =>
                    item.kind === "http" &&
                    item.service === form.service,
            )
        )
            throw new Error(
                `Service "${form.service}" already publishes http/https ports. x-caddy cannot be combined with them.`,
            );

        return setServiceCaddy(compose, form.service, form.caddy);
    }

    function nextCompose(): string {
        if (form.kind === "http") return httpCompose();

        if (form.kind === "host") return hostCompose();

        return caddyCompose();
    }

    function submit(event: Event) {
        event.preventDefault();
        error = "";

        if (!form.service) {
            error = "Choose a service first.";

            return;
        }

        try {
            onapply(nextCompose());
        } catch (cause) {
            error =
                cause instanceof Error
                    ? cause.message
                    : "Unable to update the Compose file.";

            return;
        }

        onclose();
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
    <DialogContent class="sm:max-w-xl">
        <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>
                {#if form.kind === "http"}
                    Publishes a container port as HTTPS through Caddy:
                    [hostname:]port[/http|https].
                {:else if form.kind === "host"}
                    Binds a container port to the host:
                    [bind:]host:container[/tcp|udp]@host. Bypasses
                    Caddy.
                {:else}
                    Custom Caddyfile for one service. Supports
                    {"{{upstreams 8000}}"} templates. Cannot mix with http/https
                    x-ports.
                {/if}
            </DialogDescription>
        </DialogHeader>
        <DialogPanel>
            {#if error}
                <Alert variant="error" class="mb-4">
                    <AlertDescription>
                        {error}
                    </AlertDescription>
                </Alert>
            {/if}
            {#if editingRaw !== null && editingRaw.includes("$")}
                <p
                    class="mb-4 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
                >
                    Uses Compose variables from this resource's
                    Variables — shown as written. Saving unchanged
                    keeps them.
                </p>
            {/if}
            <form
                id="ingress-form"
                method="POST"
                onsubmit={submit}
                class="space-y-4"
            >
                {#if editingCaddyService === null}
                    <div class="grid gap-4 sm:grid-cols-2">
                        <Field>
                            <Label for="ingress-kind" required>
                                Type
                            </Label>
                            <Select
                                value={form.kind}
                                items={kindOptions}
                                disabled={editingRaw !== null}
                                onValueChange={(value) => {
                                    if (
                                        value === "http" ||
                                        value === "host" ||
                                        value === "caddy"
                                    )
                                        form.kind = value;
                                }}
                            >
                                <SelectTrigger id="ingress-kind">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        value="http"
                                        label="HTTPS ingress"
                                    />
                                    <SelectItem
                                        value="host"
                                        label="TCP/UDP host port"
                                    />
                                    <SelectItem
                                        value="caddy"
                                        label="Custom Caddy"
                                    />
                                </SelectContent>
                            </Select>
                        </Field>
                        <Field>
                            <Label for="ingress-service" required>
                                Service
                            </Label>
                            <Select
                                value={form.service}
                                items={serviceOptions}
                                onValueChange={(value) =>
                                    (form.service = value ?? "")}
                            >
                                <SelectTrigger id="ingress-service">
                                    <SelectValue
                                        placeholder="Choose a service"
                                    />
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
                    </div>
                {/if}
                {#if form.kind === "http" && editingCaddyService === null}
                    <Field>
                        <Label for="ingress-hostname">Hostname</Label>
                        <Input
                            id="ingress-hostname"
                            bind:value={form.hostname}
                            placeholder="app.example.com (empty = cluster default)"
                            maxlength={253}
                            autocomplete="off"
                            spellcheck={false}
                        />
                        <p class="text-xs text-muted-foreground">
                            Point a DNS A record at your machines.
                            HTTPS certificates are automatic.
                        </p>
                    </Field>
                    <div class="grid gap-4 sm:grid-cols-2">
                        <Field>
                            <Label
                                for="ingress-container-port"
                                required
                            >
                                Container port
                            </Label>
                            <Input
                                id="ingress-container-port"
                                bind:value={form.containerPort}
                                placeholder="8000"
                                inputmode="numeric"
                                autocomplete="off"
                            />
                            {#if form.containerPort.trim() !== "" && portTextError(form.containerPort.trim()) !== null}
                                <FieldError>
                                    {portTextError(
                                        form.containerPort.trim(),
                                    )}
                                </FieldError>
                            {/if}
                        </Field>
                        <Field>
                            <Label for="ingress-protocol">
                                Protocol
                            </Label>
                            <Select
                                value={form.httpProtocol}
                                items={[
                                    {
                                        value: "https",
                                        label: "https (default)",
                                    },
                                    {
                                        value: "http",
                                        label: "http",
                                    },
                                ]}
                                onValueChange={(value) =>
                                    (form.httpProtocol =
                                        value ?? "https")}
                            >
                                <SelectTrigger id="ingress-protocol">
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        value="https"
                                        label="https (default)"
                                    />
                                    <SelectItem
                                        value="http"
                                        label="http"
                                    />
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>
                {:else if form.kind === "host" && editingCaddyService === null}
                    <Field>
                        <Label for="ingress-bind">Bind address</Label>
                        <Input
                            id="ingress-bind"
                            bind:value={form.bind}
                            placeholder="Empty = all interfaces"
                            autocomplete="off"
                            spellcheck={false}
                        />
                        {#if form.bind.trim() !== "" && bindError(form.bind.trim()) !== null}
                            <FieldError>
                                {bindError(form.bind.trim())}
                            </FieldError>
                        {/if}
                        <p class="text-xs text-muted-foreground">
                            IP or CIDR, e.g. 127.0.0.1 or
                            192.168.76.0/24. Databases should stay
                            internal unless you need them outside.
                        </p>
                    </Field>
                    <div class="grid gap-4 sm:grid-cols-3">
                        <Field>
                            <Label for="ingress-host-port" required>
                                Host port
                            </Label>
                            <Input
                                id="ingress-host-port"
                                bind:value={form.hostPort}
                                placeholder="5432"
                                inputmode="numeric"
                                autocomplete="off"
                            />
                            {#if form.hostPort.trim() !== "" && portTextError(form.hostPort.trim()) !== null}
                                <FieldError>
                                    {portTextError(
                                        form.hostPort.trim(),
                                    )}
                                </FieldError>
                            {/if}
                        </Field>
                        <Field>
                            <Label
                                for="ingress-host-container-port"
                                required
                            >
                                Container port
                            </Label>
                            <Input
                                id="ingress-host-container-port"
                                bind:value={form.hostContainerPort}
                                placeholder="5432"
                                inputmode="numeric"
                                autocomplete="off"
                            />
                            {#if form.hostContainerPort.trim() !== "" && portTextError(form.hostContainerPort.trim()) !== null}
                                <FieldError>
                                    {portTextError(
                                        form.hostContainerPort.trim(),
                                    )}
                                </FieldError>
                            {/if}
                        </Field>
                        <Field>
                            <Label for="ingress-host-protocol">
                                Protocol
                            </Label>
                            <Select
                                value={form.hostProtocol}
                                items={[
                                    {
                                        value: "tcp",
                                        label: "tcp (default)",
                                    },
                                    { value: "udp", label: "udp" },
                                ]}
                                onValueChange={(value) =>
                                    (form.hostProtocol =
                                        value ?? "tcp")}
                            >
                                <SelectTrigger
                                    id="ingress-host-protocol"
                                >
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem
                                        value="tcp"
                                        label="tcp (default)"
                                    />
                                    <SelectItem
                                        value="udp"
                                        label="udp"
                                    />
                                </SelectContent>
                            </Select>
                        </Field>
                    </div>
                {:else}
                    <Field>
                        <Label for="ingress-caddy" required>
                            Caddyfile
                            {#if editingCaddyService !== null}
                                · {editingCaddyService}
                            {/if}
                        </Label>
                        <Textarea
                            id="ingress-caddy"
                            bind:value={form.caddy}
                            rows={10}
                            maxlength={20000}
                            spellcheck={false}
                            placeholder={"example.com {\n\treverse_proxy {{upstreams 8000}}\n}"}
                            class="font-mono text-[13px]"
                        />
                        <p class="text-xs text-muted-foreground">
                            Verify with
                            <span class="font-mono">
                                uc caddy config
                            </span>
                            after deploying.
                        </p>
                    </Field>
                {/if}
            </form>
        </DialogPanel>
        <DialogFooter>
            <Button variant="outline" onclick={onclose}>
                Cancel
            </Button>
            <Button type="submit" form="ingress-form">
                <ArrowRight class="size-4" aria-hidden="true" />
                {editingRaw !== null || editingCaddyService !== null
                    ? "Apply to Compose"
                    : "Add to Compose"}
            </Button>
        </DialogFooter>
    </DialogContent>
</Dialog>
