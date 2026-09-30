import { getCollection } from "astro:content";
import { docsPages, type DocsPage, type LlmsOptions } from "@rxova/docs-kit";

/**
 * Every page as Markdown, in the sidebar's reading order: the one list the
 * `.md` twins and both llms files share.
 *
 * `docsPages` sorts by id, which put the quick start fourth in Guides, behind
 * pages that assume it. So this applies the rule Starlight applies to the
 * sidebar: `sidebar.order`, then the id. A page without an order sorts last.
 */
export const pages = async (): Promise<DocsPage[]> => {
  const entries = await getCollection("docs");
  const order = new Map(entries.map((entry) => [entry.id, entry.data.sidebar.order]));
  const rank = (page: DocsPage) => order.get(page.id) ?? Number.POSITIVE_INFINITY;
  return docsPages(entries, {
    origin: import.meta.env.SITE,
    base: import.meta.env.BASE_URL,
  }).sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id, "en"));
};

/**
 * The llms.txt header and sections, in the sidebar's reading order.
 *
 * The summary is written for a model rather than lifted from the landing page,
 * which opens with a sentence aimed at a person who has just arrived. It is the
 * paragraph a model needs first: what the tool does, what it refuses to do, and
 * the few facts that change how it is run.
 */
export const llms: LlmsOptions = {
  project: "jev-planner",
  summary: [
    "A command-line tool that writes an implementation plan for a coding task by",
    "making two or more AI agents collaborate — the Codex CLI and Claude Code by",
    "default: each drafts a plan against the repository, read-only. TypeSafe Jev",
    "scores the plans with typed answers — completeness, feasibility, risk",
    "coverage, which agent should merge them, and whether a cross-review is worth",
    "it. In the default `balanced` mode the agents revise after reading each other's",
    "plans only when Jev asks, and the chosen agent writes one final plan unless a",
    "reviewed plan already stands alone; `--mode ultra` always runs the first",
    "cross-review; `--mode fast` answers with the first draft Jev accepts on its own.",
    "The plan goes to stdout as Markdown, or as JSON with `--json`;",
    "progress goes to stderr. The agents never edit the repository; the CLI writes",
    "only its rounds folder and `-o`. Also usable as a",
    "library: `Planner` runs the same flow over any agents and judge you supply.",
    "Node >= 20.19. Published to npm. MIT.",
  ],
  sections: [
    ["root", "About"],
    ["learn", "Learn"],
    ["guides", "Guides"],
    ["reference", "Reference"],
  ],
};

/** Between the llms.txt header and the sections: how to install it, and the facts that prevent failed runs. */
export const preamble = [
  "## Install",
  "",
  "    npm install -g jev-planner",
  "",
  'Or run it without installing: `npx jev-planner "<coding task>"`. The package',
  "also ships its own `llms.txt` inside the tarball, so after an install it can",
  "be read from `node_modules/jev-planner/llms.txt` with no network access.",
  "",
  "## If you are about to run it",
  "",
  "Five facts prevent most failed or surprising runs:",
  "",
  "1. It needs the `codex` and `claude` CLIs on the PATH, both logged in, and",
  "   `TYPESAFE_API_KEY` set. `jev-planner doctor` checks all of these at once.",
  "   One provider can be both agents under two names: `--agents codex:sol,codex:terra`,",
  "   with overrides by name (`--model sol=…`).",
  "2. With the default two agents and the standard review, a run makes two to",
  "   seven agent calls and one to three Jev calls, all of them billed;",
  "   `--mode fast` makes two or three, `--mode ultra` five or seven. The debate",
  "   review adds two, and `--claim-checks` one per agent that checks a claim.",
  "   A run takes minutes. `--timeout` applies to each call (default 600",
  "   seconds), not to the whole run.",
  "3. The plan goes to stdout and progress goes to stderr, so `> PLAN.md` captures",
  "   only the plan. `-o` writes the file itself; `--json` adds the verdict.",
  "4. The agents run read-only, in Codex's read-only sandbox and in Claude's plan",
  "   mode, against the directory given by `--cwd`. They edit nothing; the CLI",
  "   writes a `.jev-planner/` rounds folder unless `--no-rounds` is passed.",
  "5. The task can be an argument, a file (`-f`), piped on stdin, or `task` in a",
  "   `jev-planner.json`, which pins any setting and which a flag beats. Giving",
  "   both arguments and `--file`, or piping a task the config also sets, is an error.",
  "",
];
