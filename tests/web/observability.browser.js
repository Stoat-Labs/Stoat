// Paste into the browser console on /observability with two reporting machines.
// Re-run after refresh, range changes, and resizing to exercise live domain updates.
async function checkCharts() {
    const charts = [...document.querySelectorAll("[data-slot=chart]")].slice(0, 5);

    const frame = () =>
        new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        );

    const assert = (valid, message) => {
        if (!valid) throw new Error(message);
    };

    assert(charts.length === 5, "Wait for all five host charts to load");

    for (const chart of charts) {
        const plot = chart.querySelector(".lc-tooltip-context");
        const bounds = plot.getBoundingClientRect();
        const paths = [...chart.querySelectorAll(".lc-path")];
        assert(paths.length >= 2, "Select at least two reporting machines");
        assert(
            getComputedStyle(chart.querySelector(".lc-root-container")).overflow === "hidden",
            "Chart must clip to its card",
        );

        for (const path of paths) {
            const rect = path.getBoundingClientRect();
            assert(
                rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1,
                "Live x domain escaped the plot",
            );
            assert(
                rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1,
                "Live y domain escaped the plot",
            );
            assert(
                getComputedStyle(path.parentElement).clipPath !== "none",
                "Marks need a plot clip",
            );
        }

        assert(!chart.textContent?.includes("−"), "Rates must not be mirrored below zero");

        for (const path of paths.slice(0, 2)) {
            // Hover an actual sample vertex, rather than an interpolated point between timestamps.
            const vertices = [...path.getAttribute("d").matchAll(/[ML]([\d.-]+),([\d.-]+)/g)];
            const vertex = vertices[Math.floor(vertices.length / 2)];

            const point = new DOMPoint(Number(vertex[1]), Number(vertex[2])).matrixTransform(
                path.getScreenCTM(),
            );

            plot.dispatchEvent(
                new PointerEvent("pointerenter", {
                    bubbles: true,
                    clientX: point.x,
                    clientY: point.y,
                }),
            );
            plot.dispatchEvent(
                new PointerEvent("pointermove", {
                    bubbles: true,
                    clientX: point.x,
                    clientY: point.y,
                }),
            );
            await frame();
            const color = path.getAttribute("stroke");

            for (const sibling of charts) {
                assert(
                    sibling.querySelectorAll(".lc-highlight-line").length === 1,
                    "Cursor must synchronize across charts",
                );

                for (const line of sibling.querySelectorAll(".lc-path")) {
                    const expected = line.getAttribute("stroke") === color ? 1 : 0.15;
                    assert(
                        Number(getComputedStyle(line).opacity) === expected,
                        "Hovered machine must highlight in every chart",
                    );
                }
            }
        }

        chart.dispatchEvent(new PointerEvent("pointerleave", { bubbles: false }));
        await frame();
        assert(
            charts.every((item) =>
                [...item.querySelectorAll(".lc-path")].every(
                    (path) => getComputedStyle(path).opacity === "1",
                ),
            ),
            "Leaving must clear machine highlighting",
        );
    }

    for (const chart of charts.slice(3)) {
        const paths = [...chart.querySelectorAll(".lc-path")];
        assert(
            paths.some((path) => path.getAttribute("stroke-dasharray") === "4 3"),
            "Send/write must be dashed",
        );
        assert(
            paths.some((path) => !path.getAttribute("stroke-dasharray")),
            "Receive/read must be solid",
        );
    }

    return "Chart bounds, shared hover/cursors, reset, and positive directional rates passed";
}

checkCharts().then(console.info);

// Run after the three service charts have loaded; watches one complete polling interval.
async function checkServiceChartRefresh() {
    const titles = ["CPU by service", "Memory by service", "Network by service"];

    const panels = titles.map((title) =>
        [...document.querySelectorAll('[data-slot="frame"]')].find((frame) =>
            [...frame.querySelectorAll('[data-slot="frame-title"]')].some(
                (heading) => heading.textContent.trim() === title,
            ),
        ),
    );

    const charts = panels.map((panel) => panel?.querySelector('[data-slot="chart"]'));

    if (charts.some((chart) => !chart)) throw new Error("Wait for all service charts to load");

    const heights = panels.map(
        (panel) => panel.querySelector('[data-slot="frame-panel"]').getBoundingClientRect().height,
    );

    if (Math.max(...heights) - Math.min(...heights) > 1)
        throw new Error("Service chart panels must have equal heights");

    for (const panel of panels) {
        const legend = panel.querySelector('[aria-label$=" legend"]');

        if (getComputedStyle(legend).display !== "grid")
            throw new Error("Service legends must use aligned rows instead of wrapping");

        for (const button of legend.querySelectorAll("button")) {
            const label = button.querySelector(".truncate");

            if (getComputedStyle(label).whiteSpace !== "nowrap" || !button.title)
                throw new Error("Legend names must stay on one line with full names available");
        }
    }

    await new Promise((resolve, reject) => {
        const observer = new MutationObserver(() => {
            if (charts.some((chart) => !chart.isConnected)) {
                clearTimeout(timeout);
                observer.disconnect();
                reject(new Error("A service chart disappeared during refresh"));
            }
        });

        const timeout = setTimeout(() => {
            observer.disconnect();
            resolve();
        }, 35_000);

        for (const panel of panels) observer.observe(panel, { childList: true, subtree: true });
    });

    return "Service charts stayed mounted throughout live refresh";
}

checkServiceChartRefresh().then(console.info);
