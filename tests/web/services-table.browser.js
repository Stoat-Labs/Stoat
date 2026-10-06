// Run in the browser console on /observability after services load.
// Repeat at wide desktop and narrow widths, and after expanding a service.
function checkServicesTableWidth() {
    const viewport = document.querySelector('[aria-label="Services usage table"]');
    const table = viewport?.querySelector("table");
    const header = table?.querySelector("thead tr");
    const rows = [...(table?.querySelectorAll("tbody tr") ?? [])];

    if (!header || !rows.length) throw new Error("Wait for service rows to load");

    const bounds = table.getBoundingClientRect();
    const headings = [...header.children].map((cell) => cell.getBoundingClientRect());

    for (const cell of header.children) {
        const style = getComputedStyle(cell);

        if (style.display !== "flex" || style.alignItems !== "center")
            throw new Error("All header labels must be vertically centered in grid cells");

        const button = cell.querySelector("button");

        if (button && getComputedStyle(button).fontSize !== style.fontSize)
            throw new Error("Sortable and non-sortable headings must use the same text size");
    }

    const minimumWidth = 82 * parseFloat(getComputedStyle(document.documentElement).fontSize);

    if (Math.abs(bounds.width - Math.max(viewport.clientWidth, minimumWidth)) > 2)
        throw new Error("Table must fill its viewport or scroll at its minimum width");

    for (const row of [header, ...rows]) {
        const cells = [...row.children];

        if (cells.length !== headings.length) continue;

        const last = cells.at(-1).getBoundingClientRect();

        if (Math.abs(last.right - bounds.right) > 2)
            throw new Error("Columns leave unused space at the right edge");

        cells.forEach((cell, index) => {
            const rect = cell.getBoundingClientRect();

            if (
                Math.abs(rect.left - headings[index].left) > 2 ||
                Math.abs(rect.width - headings[index].width) > 2
            )
                throw new Error("Header and virtual row columns must align");
        });
    }

    return "Service columns fill the table and align with the header";
}

checkServicesTableWidth();
