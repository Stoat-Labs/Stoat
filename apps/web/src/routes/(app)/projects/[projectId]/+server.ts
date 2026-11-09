import { redirect } from "@sveltejs/kit";

// The project list view is gone; old links open the canvas.
export const GET = ({ params }) => redirect(308, `/projects/${params.projectId}/canvas`);
