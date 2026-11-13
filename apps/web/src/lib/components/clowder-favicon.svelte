<script lang="ts">
    import { onMount } from "svelte";

    // static/favicon.svg covers first paint; after that the tab icon is redrawn in the current
    // --primary / --primary-foreground, so it follows the accent and light/dark like the rest of the app.
    const mark =
        "M14.14 10.43A28 28 0 0 0 32.18 60A39.5 39.5 0 0 1 14.14 10.43ZM25.49 4.77A32.5 32.5 0 0 0 44.52 57.05A28 28 0 0 0 50.58 52.95A39.5 39.5 0 0 1 32.77 4.01A28 28 0 0 0 25.49 4.77ZM39.88 5.13A32.5 32.5 0 0 0 55.31 47.51A28 28 0 0 0 39.88 5.13Z";

    onMount(() => {
        const link = document.querySelector<HTMLLinkElement>(
            'link[rel="icon"][type="image/svg+xml"]',
        );

        if (!link) return;

        const draw = () => {
            const style = getComputedStyle(document.documentElement);
            const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="${style.getPropertyValue("--primary")}"/><path d="${mark}" fill="${style.getPropertyValue("--primary-foreground")}" transform="translate(7.04 7.04) scale(.78)"/></svg>`;
            link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
        };

        draw();
        // setTheme, setAccent and the OS-follow script in app.html all change these two attributes.
        const observer = new MutationObserver(draw);
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ["class", "data-accent"],
        });

        return () => observer.disconnect();
    });
</script>
