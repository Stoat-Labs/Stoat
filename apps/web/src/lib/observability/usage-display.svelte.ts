import { browser } from "$app/environment";
import type { UsageDisplay } from "$lib/observability";

function readUsageDisplay(): UsageDisplay {
    if (!browser) return "percent";

    return document.cookie.includes("observability_usage=absolute") ? "absolute" : "percent";
}

// Only rendered after mount (the header toolbar and client-fetched charts), so the server never needs the cookie.
export const usageDisplay = $state({ current: readUsageDisplay() });

export function setUsageDisplay(value: UsageDisplay) {
    usageDisplay.current = value;
    document.cookie = `observability_usage=${value}; path=/; max-age=31536000; samesite=lax`;
}
