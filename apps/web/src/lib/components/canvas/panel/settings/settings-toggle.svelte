<script lang="ts">
    import { Switch } from "$lib/components/ui/switch";

    let {
        label,
        checked,
        disabled,
        onchange,
    }: {
        label: string;
        checked: boolean;
        disabled: boolean;
        onchange: (checked: boolean) => void;
    } = $props();
</script>

<!-- A Railway toggle row: a tinted bar holding the switch and its label. -->
<label
    class="mt-3 flex cursor-pointer items-center gap-4 rounded-md bg-muted/60 px-4 py-3"
>
    <Switch
        {checked}
        {disabled}
        onCheckedChange={(next) => onchange(next)}
    />
    <span class="text-base">{label}</span>
</label>
