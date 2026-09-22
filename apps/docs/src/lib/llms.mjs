// The llms.txt pair: https://llmstxt.org
//
// `llms.txt` is an index — headings and links, small enough that fetching it
// costs nothing and an agent can decide what else to read. `llms-full.txt` is
// every page inlined, for the case where one fetch should be the whole thing.
//
// Both are built from `docsPages()`, the same enumeration the `.md` twins use,
// so the three surfaces cannot disagree about what pages exist. Everything here
// is pure — the endpoints in src/pages are three-line adapters — because the
// shape of these documents is the part worth testing, and checking it needs no
// Astro.
//
// This file matters more than its size suggests. An agent that reaches it is
// usually deciding whether to shell out to `jev-planner`, and the summary below
// is the paragraph it sees first. The facts that matter before that first call
// are the ones that make a run fail or surprise: two CLI logins and an API key,
// several paid model calls per run, minutes rather than seconds, and a result
// on stdout with progress on stderr.

/**
 * The library's own summary, as the blockquote llmstxt.org puts under the H1.
 *
 * Written here rather than lifted from a page's frontmatter: `index.md` opens
 * with a sentence aimed at a person who has just arrived. This is the paragraph
 * a model needs first — what the package exports, what it refuses to do, and
 * the few facts that change how the calling code is written.
 */
const SUMMARY = [
  'A command-line tool that writes an implementation plan for a coding task by',
  'making two or more AI agents collaborate — the Codex CLI and Claude Code by',
  'default: each drafts a plan against the repository, read-only. TypeSafe Jev',
  'scores the plans with typed answers — completeness, feasibility, risk',
  'coverage, which agent should merge them, and whether a cross-review is worth',
  "it. In the default `balanced` mode the agents revise after reading each other's",
  'plans only when Jev asks, and the chosen agent writes one final plan unless a',
  'reviewed plan already stands alone; `--mode ultra` always runs the first',
  'cross-review; `--mode fast` answers with the first draft Jev accepts on its own.',
  'The plan goes to stdout as Markdown, or as JSON with `--json`;',
  'progress goes to stderr. The agents never edit the repository; the CLI writes',
  'only its rounds folder and `-o`. Also usable as a',
  'library: `Planner` runs the same flow over any agents and judge you supply.',
  'Node >= 20.19. Published to npm. MIT.',
]

/**
 * Directory name -> heading, in reading order.
 *
 * Mirrors the sidebar in astro.config.mjs, because that order is a real
 * editorial judgement about what to read first and there is no reason for an
 * agent to get a worse one than a human. A directory missing from this map still
 * gets a heading — see `groupPages` — so adding one is not a silent omission,
 * just an unlabelled section.
 */
const SECTIONS = [
  ['root', 'About'],
  ['learn', 'Learn'],
  ['guides', 'Guides'],
  ['reference', 'Reference'],
]

/**
 * One entry. The description is what makes the index worth fetching: a bare list
 * of links tells an agent nothing about which one answers its question.
 */
const link = (page, note) => `- [${page.title}](${page.mdUrl})${note ? `: ${note}` : ''}`

/** Group pages by section, in the order a reader should meet them. */
export function groupPages(pages) {
  const bySection = new Map()
  for (const page of pages) {
    if (!bySection.has(page.section)) bySection.set(page.section, [])
    bySection.get(page.section).push(page)
  }

  const groups = []
  const take = (key, heading) => {
    const found = bySection.get(key)
    if (found?.length) groups.push({ heading, pages: found })
    bySection.delete(key)
  }

  for (const [key, heading] of SECTIONS) take(key, heading)

  // A directory the map does not know, named after itself: an unlabelled section
  // beats a missing one.
  for (const key of [...bySection.keys()].sort()) take(key, key)

  return groups
}

/**
 * The index.
 *
 * Links point at the `.md` twins rather than the HTML pages. An agent following
 * a link from here wants the content, not the chrome — and sending it to HTML
 * when a markdown twin exists wastes the fetch this file exists to save.
 */
export function llmsIndex(pages, origin) {
  const lines = [
    '# jev-planner',
    '',
    ...SUMMARY.map((l) => `> ${l}`),
    '',
    'Every link below is raw markdown. The human page is the same URL without the',
    '`.md` suffix.',
    '',
    // Absolute, not "the file beside this one". This document is read detached
    // from the site as often as it is fetched from it, and a reader that has it
    // pasted into a prompt has nothing to resolve a relative reference against.
    `Everything inlined in one fetch: ${origin}/llms-full.txt`,
    '',
    '## Install',
    '',
    '    npm install -g jev-planner',
    '',
    'Or run it without installing: `npx jev-planner "<coding task>"`. The package',
    'also ships its own `llms.txt` inside the tarball, so after an install it can',
    'be read from `node_modules/jev-planner/llms.txt` with no network access.',
    '',
    '## If you are about to run it',
    '',
    'Five facts prevent most failed or surprising runs:',
    '',
    '1. It needs the `codex` and `claude` CLIs on the PATH, both logged in, and',
    '   `TYPESAFE_API_KEY` set. `jev-planner doctor` checks all of these at once.',
    '2. With the default two agents and the standard review, a run makes two to',
    '   seven agent calls and one to three Jev calls, all of them billed;',
    '   `--mode fast` makes two or three, `--mode ultra` five or seven. The debate',
    '   review adds two, and `--claim-checks` one per agent that checks a claim.',
    '   A run takes minutes. `--timeout` applies to each call (default 600',
    '   seconds), not to the whole run.',
    '3. The plan goes to stdout and progress goes to stderr, so `> PLAN.md` captures',
    '   only the plan. `-o` writes the file itself; `--json` adds the verdict.',
    "4. The agents run read-only, in Codex's read-only sandbox and in Claude's plan",
    '   mode, against the directory given by `--cwd`. They edit nothing; the CLI',
    '   writes a `.jev-planner/` rounds folder unless `--no-rounds` is passed.',
    '5. The task can be an argument, a file (`-f`) or piped on stdin, but only one',
    '   of these; giving both arguments and `--file` is an error.',
    '',
  ]

  for (const { heading, pages: group } of groupPages(pages)) {
    lines.push(`## ${heading}`, '')
    for (const page of group) lines.push(link(page, page.description))
    lines.push('')
  }

  return lines.join('\n')
}

/** Everything inlined, in the same order the index lists it. */
export function llmsFull(pages) {
  const ordered = groupPages(pages).flatMap((g) => g.pages)
  const head = ['# jev-planner', '', ...SUMMARY.map((l) => `> ${l}`), ''].join('\n')

  return [
    head,
    ...ordered.map((page) =>
      ['---', '', `# ${page.title}`, '', `Source: ${page.htmlUrl}`, '', page.body, ''].join('\n'),
    ),
  ].join('\n')
}
