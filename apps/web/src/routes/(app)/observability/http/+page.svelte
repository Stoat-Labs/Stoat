<script lang="ts">
    import HttpTraffic from "$lib/components/observability/http-traffic.svelte";
</script>

<p>
    Caddy might push to the wrong alloy server, there's pretty much
    nothing we can do about it, this would cause wrong data to be
    shown
</p>
<HttpTraffic />
