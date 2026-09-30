import type { APIRoute } from "astro";
import { llmsIndex } from "@rxova/docs-kit";
import { llms, pages, preamble } from "../lib/docs";

// https://jev-planner.com/llms.txt — the agent-facing index. The mount, not the
// bare origin: served from a sub-path, a URL that dropped the base would 404 in
// the one place it is meant to be followed.
export const prerender = true;
export const GET: APIRoute = async () =>
  new Response(
    llmsIndex(await pages(), {
      ...llms,
      mount: `${import.meta.env.SITE}${import.meta.env.BASE_URL}`,
      preamble,
    }),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
