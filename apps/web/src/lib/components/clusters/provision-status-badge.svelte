<script lang="ts">
    import { Badge } from "$lib/components/ui/badge";
    import type { ClusterProvisionStatus } from "@stoat/db/schema/index";

    let { status }: { status: ClusterProvisionStatus } = $props();
</script>

{#if status === "pending"}
    <Badge variant="info">Waiting for key</Badge>
{:else if status === "queued"}
    <Badge variant="secondary">Queued</Badge>
{:else if status === "running"}
    <Badge variant="warning">Setting up</Badge>
{:else if status === "failed"}
    <Badge variant="error">Failed</Badge>
{:else}
    <Badge variant="success">Ready</Badge>
{/if}
