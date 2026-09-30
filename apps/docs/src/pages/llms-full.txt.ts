import type { APIRoute } from "astro";
import { llmsFull } from "@rxova/docs-kit";
import { llms, pages } from "../lib/docs";

// https://jev-planner.com/llms-full.txt — every page inlined, in the order
// llms.txt lists them, for an agent that wants the whole thing in one fetch.
export const prerender = true;
export const GET: APIRoute = async () =>
  new Response(llmsFull(await pages(), llms), {
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
