// Run in the browser console on a resource's metrics page with deployed services.
// Exercises the real metrics link and service discovery without pressing Search.
async function checkMetricsLogSearch() {
    const link = [...document.querySelectorAll("a")].find(
        (item) => item.textContent.trim() === "Logs for this range",
    );

    if (!link) throw new Error("Wait for resource metrics to load");
    link.click();

    const deadline = Date.now() + 30_000;
    let completed = false;

    while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const summary = document.querySelector("p[title]");

        if (
            summary?.title.includes(" to ") &&
            !document.body.textContent.includes("Searching logs...")
        ) {
            completed = true;
            break;
        }
    }

    if (!completed) throw new Error("Metrics link did not automatically search its range");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    if (document.body.textContent.includes("Search stored logs")) {
        throw new Error("Service discovery cleared the historical search");
    }

    return "Metrics log range searched automatically and remained loaded";
}

checkMetricsLogSearch().then(console.info);
