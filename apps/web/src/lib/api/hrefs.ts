export function projectHref(projectId: string) {
    return `/projects/${projectId}/canvas`;
}

// A resource opens as the selected card on its project's canvas.
export function resourceHref(projectId: string, resourceId: string) {
    return `/projects/${projectId}/canvas?node=${resourceId}`;
}
