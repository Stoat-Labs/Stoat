import { browser } from "$app/environment";

export const themes = ["system", "light", "dark"] as const;

export type Theme = (typeof themes)[number];

export const themeLabels: Record<Theme, string> = {
    system: "System",
    light: "Light",
    dark: "Dark",
};

function readTheme(): Theme {
    if (!browser) return "dark";
    const value = document.cookie.match(/(?:^|; )theme=(\w+)/)?.[1];

    return themes.find((theme) => theme === value) ?? "dark";
}

// Per device, in a cookie so the inline script in app.html can apply it before first paint.
export const theme = $state({ current: readTheme() });

export function setTheme(value: Theme) {
    theme.current = value;
    document.cookie = `theme=${value}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.classList.toggle(
        "dark",
        value === "dark" ||
            (value === "system" && matchMedia("(prefers-color-scheme: dark)").matches),
    );
}

// Swatch colors match the `[data-accent]` blocks in app.css. Lime has no block: it is the default.
export const accents = [
    { value: "lime", label: "Lime", color: "oklch(0.86 0.2 128)" },
    { value: "teal", label: "Teal", color: "oklch(0.7 0.12 180)" },
    { value: "sky", label: "Sky", color: "oklch(0.68 0.14 240)" },
    { value: "violet", label: "Violet", color: "oklch(0.6 0.19 305)" },
    { value: "pink", label: "Pink", color: "oklch(0.7 0.18 350)" },
    { value: "orange", label: "Orange", color: "oklch(0.68 0.19 45)" },
    { value: "mono", label: "Monochrome", color: "oklch(0.97 0 0)" },
] as const;

export type Accent = (typeof accents)[number]["value"];

function readAccent(): Accent {
    if (!browser) return "lime";
    const value = document.cookie.match(/(?:^|; )accent=(\w+)/)?.[1];

    return accents.find((accent) => accent.value === value)?.value ?? "lime";
}

// Per device like the theme, so app.html can apply it before first paint.
export const accent = $state({ current: readAccent() });

export function setAccent(value: Accent) {
    accent.current = value;
    document.cookie = `accent=${value}; path=/; max-age=31536000; samesite=lax`;
    document.documentElement.dataset.accent = value;
}
