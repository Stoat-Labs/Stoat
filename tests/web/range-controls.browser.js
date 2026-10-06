// Paste into the browser console on any metrics page. This selects a different preset.
async function checkRangeControls() {
    const assert = (valid, message) => {
        if (!valid) throw new Error(message);
    };

    const settle = () => new Promise((resolve) => setTimeout(resolve, 400));
    const trigger = document.querySelector('button[aria-label="Select time range"]');
    assert(trigger, "Wait for the metrics toolbar to load");
    trigger.click();
    await settle();
    const popup = document.querySelector('[data-slot="popover-popup"]');
    assert(popup?.querySelector('[data-slot="frame"]'), "Time picker must use a Frame");
    const presets = [...popup.querySelectorAll("button[aria-pressed]")];
    assert(presets.length === 8, "Every existing preset must remain available");
    const selected = presets.find((button) => button.getAttribute("aria-pressed") === "true");
    const inputs = [...popup.querySelectorAll('input[type="datetime-local"]')];
    assert(inputs.length === 2, "Custom range needs From and To fields");

    if (selected) {
        const [, count, unit] = selected.textContent.trim().match(/Last (\d+) (hours?|days?)/);
        const expected = Number(count) * (unit.startsWith("hour") ? 3600 : 86400);
        const actual = (new Date(inputs[1].value) - new Date(inputs[0].value)) / 1000;
        assert(
            Math.abs(actual - expected) <= 3600,
            "Custom draft must start from the selected period (allowing DST)",
        );
    }

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
    setValue.call(inputs[1], inputs[0].value);
    inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    await settle();
    assert(
        popup.querySelector('button[type="submit"]').disabled,
        "Empty windows must not be applied",
    );
    assert(popup.querySelector('[role="alert"]'), "Invalid range must explain the error");
    const next = presets.find((button) => button !== selected);
    const nextLabel = next.textContent.trim();
    next.click();
    await settle();
    assert(
        trigger.textContent.trim() === nextLabel,
        "Preset selection must update the compact trigger",
    );
    const params = new URLSearchParams(location.search);
    assert(!params.has("from") && !params.has("to"), "Presets must clear the fixed range");
    assert(trigger.getAttribute("aria-expanded") === "false", "Selection must close the picker");

    return "Framed picker, presets, draft initialization and range validation passed";
}

checkRangeControls().then(console.info);
