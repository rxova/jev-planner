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
  'Implementation plans from two or more AIs — Codex and Claude by default — that draft ' +
  "independently, review each other's work when it helps, and let TypeSafe Jev decide."

export const INSTALL = 'npm install -g jev-planner'

export const GITHUB = 'https://github.com/rxova/jev-planner'

export const GET_STARTED = '/guides/getting-started/'

/**
 * The demo transcript: the command from the README, then the stage lines
 * `Planner.plan()` really prints. No scores, timings or winning agent — those
 * differ on every run, and a demo that invents them is a claim.
 *
 * `kind` is presentation only: the command, a line jev-planner prints, and a
 * note that is not output at all.
 */
export const TRANSCRIPT = [
  {
    kind: 'command',
    text: 'jev-planner -o PLAN.md "Add per-user rate limiting to the public API"',
  },
  { kind: 'output', text: '[jev-planner] Drafting independent plans with Codex and Claude…' },
  { kind: 'output', text: '[jev-planner] Asking Jev for typed quality and routing decisions…' },
  { kind: 'note', text: '# only if Jev asks for a cross-review:' },
  { kind: 'output', text: '[jev-planner] Cross-reviewing the 2 drafts…' },
  { kind: 'output', text: '[jev-planner] Re-evaluating the revised plans with Jev…' },
  { kind: 'note', text: '# then the agent Jev chose merges the plans, unless one stands alone' },
  { kind: 'output', text: '[jev-planner] Wrote /home/you/my-app/PLAN.md' },
]

/** Four claims, each quoted from the README and linked to the page that explains it. */
export const FEATURES = [
  {
    title: 'Independent drafts',
    body: 'Each agent — Codex and Claude by default — drafts a plan independently, all in parallel.',
    href: '/learn/how-it-works/#1-independent-drafts',
  },
  {
    title: "Jev's typed verdict",
    body:
      'Jev scores completeness, feasibility, and risk coverage; chooses a finalizer; and decides ' +
      'whether a cross-review would materially improve the plan.',
    href: '/learn/how-it-works/#2-jev-evaluates',
  },
  {
    title: 'Cross-review',
    body:
      "When it would, each agent sees every other agent's plan and returns a revised, " +
      'standalone plan.',
    href: '/learn/how-it-works/#3-cross-review',
  },
  {
    title: 'Any AI, one entry',
    body:
      'Every agent comes from one list, PROVIDERS. Adding an AI is one entry there: an agent CLI ' +
      'or any OpenAI-compatible chat API.',
    href: '/reference/adding-an-ai/',
  },
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
    ...TRANSCRIPT.map(({ kind, text }) => (kind === 'command' ? `$ ${text}` : text)),
    '```',
    '',
    '## Features',
    '',
    ...FEATURES.map(({ title, body: text, href }) => `- [${title}](${url(href)}): ${text}`),
    '',
    `[Get started](${url(GET_STARTED)}) · [GitHub](${GITHUB})`,
  ].join('\n')

  return renderMarkdown({ title: TITLE, description: TAGLINE, htmlUrl: url('/'), body })
}
