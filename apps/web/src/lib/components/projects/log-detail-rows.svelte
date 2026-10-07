<script lang="ts">
    import type { DisplayLog } from "$lib/resources/logs";

    let {
        log,
        machineName,
    }: {
        log: DisplayLog;
        machineName: string | null;
    } = $props();
</script>

<div>
    <dt class="inline text-muted-foreground">Service</dt>
    <dd class="inline font-mono wrap-anywhere">
        {log.serviceName}
    </dd>
</div>
<div>
    <dt class="inline text-muted-foreground">Machine</dt>
    <dd class="inline font-mono wrap-anywhere">
        {machineName ?? "Not recorded"}
    </dd>
</div>
<div>
    <dt class="inline text-muted-foreground">Container</dt>
    <dd class="inline font-mono wrap-anywhere">
        {log.container ?? "Not recorded"}
    </dd>
</div>
<div>
    <dt class="inline text-muted-foreground">Stream</dt>
    <dd class="inline font-mono">
        {log.stream ?? "Not recorded"}
    </dd>
</div>
