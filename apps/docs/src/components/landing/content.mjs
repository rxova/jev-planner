// The landing page's copy, in one place.
//
// Both src/pages/index.astro and its `.md` twin (src/pages/index.md.ts) read
// from here, so the page a person sees and the one an agent fetches say the same
// thing. Every claim is lifted from packages/jev-planner/README.md; nothing here
// is allowed to promise more than the README does.

import { renderMarkdown } from '../../lib/docs-pages.mjs'
import { withBase } from '../../lib/base-url.mjs'

export const TITLE = 'jev-planner'

export const TAGLINE =
  'A coding task in, one implementation plan out: Codex and Claude each draft against your ' +
  'repository, TypeSafe Jev judges the drafts and calls a cross-review when it would help, and ' +
  'one agent writes the final plan.'

export const INSTALL = 'npm install -g jev-planner'

export const GITHUB = 'https://github.com/rxova/jev-planner'

export const GET_STARTED = '/guides/getting-started/'

/** The command the transcript below runs, from the README. */
const DEMO_COMMAND = 'jev-planner -o PLAN.md "Add per-user rate limiting to the public API"'

/** The last line of a run, whichever way it ended. */
const WROTE = '[jev-planner] Wrote /home/you/my-app/PLAN.md'

/**
 * The four stages of a run, in order: the sequence the landing page exists to
 * teach.
 *
 * One export feeds three things — the stage labels in the transcript, the cards
 * under it, and the `.md` twin — so a reader, a card and an agent cannot be told
 * three different stories. `lines` are the strings the run really prints
 * (`orchestrator.ts:61,72,106,169`, `synthesis.ts:66`); no scores, timings or
 * winning agent, because those differ on every run and a demo that invents them
 * is a claim.
 *
 * `kind` is presentation only: a line jev-planner prints, and a note that is not
 * output at all.
 */
export const STAGES = [
  {
    n: 1,
    label: 'Draft',
    what: 'Each agent — Codex and Claude by default — plans alone against the repository, all in parallel; none sees another draft.',
    href: '/learn/how-it-works/#1-independent-drafts',
    lines: [
      { kind: 'output', text: '[jev-planner] Drafting independent plans with Codex and Claude…' },
    ],
  },
  {
    n: 2,
    label: 'Jev judges',
    what: 'Jev scores completeness, feasibility and risk coverage, chooses a finalizer, and decides whether a cross-review would materially improve the plan.',
    href: '/learn/how-it-works/#2-jev-evaluates',
    lines: [
      { kind: 'output', text: '[jev-planner] Asking Jev for typed quality and routing decisions…' },
    ],
  },
  {
    n: 3,
    label: 'Cross-review',
    optional: true,
    what: "When Jev asks for one, each agent sees every other agent's plan and returns a revised, standalone plan — which Jev judges again.",
    href: '/learn/how-it-works/#3-cross-review',
    lines: [
      { kind: 'output', text: '[jev-planner] Cross-reviewing the 2 drafts…' },
      { kind: 'output', text: '[jev-planner] Re-evaluating the revised plans with Jev…' },
    ],
  },
  {
    n: 4,
    label: 'Final plan',
    what: 'The agent Jev chose merges the strongest ideas into one plan, unless one reviewed plan already stands alone.',
    href: '/learn/how-it-works/#4-synthesis',
    lines: [
      {
        kind: 'note',
        text:
          '# then "Synthesizing the final plan with …": the agent Jev chose merges the plans, ' +
          'or one reviewed plan is adopted as it stands',
      },
    ],
  },
]

/** The stage's own line in the transcript: the number, the label, the point. */
const stageLine = ({ n, label, what, optional }) =>
  `${String(n)} · ${label}${optional ? ' (only when Jev asks)' : ''} — ${what}`

/**
 * The demo transcript: the command from the README, then each stage announcing
 * itself and printing what it prints.
 */
export const TRANSCRIPT = [
  { kind: 'command', text: DEMO_COMMAND },
  ...STAGES.flatMap((stage) => [{ kind: 'stage', text: stageLine(stage) }, ...stage.lines]),
  { kind: 'output', text: WROTE },
]

/**
 * The landing page as markdown, for `/index.md`.
 *
 * Links are absolute: the twin is read detached from the site as often as it is
 * fetched from it, and check-md-routes rejects a root-relative link in one.
 *
 * @param {{ origin: string, base: string }} site
 */
export function landingMarkdown({ origin, base }) {
  const url = (path) => `${origin}${withBase(path, base)}`
  const body = [
    TAGLINE,
    '',
    '```sh',
    INSTALL,
    '```',
    '',
    '## Example run',
    '',
    '```text',
    ...TRANSCRIPT.map(({ kind, text }) => {
      if (kind === 'command') return `$ ${text}`
      // A stage label is not output, so it is not dressed up as any.
      return kind === 'stage' ? `# ${text}` : text
    }),
    '```',
    '',
    '## The four stages',
    '',
    ...STAGES.map(
      ({ n, label, what, href }) => `- [${String(n)}. ${label}](${url(href)}): ${what}`,
    ),
    '',
    `[Get started](${url(GET_STARTED)}) · [Star on GitHub](${GITHUB})`,
  ].join('\n')

  return renderMarkdown({ title: TITLE, description: TAGLINE, htmlUrl: url('/'), body })
}
