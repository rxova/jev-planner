import { MAX_OBJECTIONS } from './debate.js'
import type { AgentName, Dispute, DisputeRuling, JevVerdict, Objection } from './types.js'

/** A plan and the agent that wrote it, as a prompt shows it. */
export interface AuthoredPlan {
  label: string
  plan: string
  /** The agent's name, for a prompt that asks for answers addressed to it: a critique's `TARGET:`. */
  name?: AgentName
}

/**
 * The rules every stage shares. How much of the repository to read differs by
 * stage: only the draft explores it; later stages open a file to settle a point.
 */
function planContract(repository: string): string {
  return `
You are designing an implementation plan, not implementing code. Work read-only.
${repository} Make the plan specific to files and symbols that exist.
Call out assumptions and unresolved questions. Prefer a small, verifiable sequence of changes.
Include architecture, edge cases, tests, validation, and rollout/compatibility concerns.
If the task is a placeholder or too vague to act on, say so and list the clarifying questions instead of inventing scope.
Keep the response under 1,500 words. Return Markdown only.`
}

const EXPLORE = 'Inspect the repository before deciding.'
const CHECK_DISPUTES =
  'You examined the repository while drafting. Open a file only to check a claim on which the plans disagree, or one you are unsure of.'
const SETTLE_CONTRADICTIONS =
  'Work from the plans below. Open a file only to settle a contradiction between them.'

/** "Claude", "Claude and GLM", "Claude, GLM and Kimi". */
export function listLabels(labels: readonly string[]): string {
  return labels.join(', ').replace(/, ([^,]*)$/, ' and $1')
}

function planBlocks(plans: readonly AuthoredPlan[], tag: string): string {
  return plans
    .map(
      ({ label, plan, name }) =>
        `${label}'s plan:\n<${tag} author="${label}"${name === undefined ? '' : ` agent="${name}"`}>\n${plan}\n</${tag}>`,
    )
    .join('\n\n')
}

export function initialPlanPrompt(task: string, peers: readonly string[]): string {
  return `${planContract(EXPLORE)}

You are the first planner in a collaboration with ${listLabels(peers)}. Produce your strongest independent plan.

Task:
<task>
${task}
</task>`
}

/** The task, unless the agent is continuing a conversation that already has it. */
function taskBlock(task: string, resumed: boolean | undefined): string {
  return resumed ? '' : `Task:\n<task>\n${task}\n</task>\n\n`
}

/**
 * `resumed` is for an agent continuing its own conversation, which already
 * holds the task and its last plan: both are left out.
 */
export function revisionPrompt(input: {
  task: string
  ownPlan: string
  peerPlans: readonly AuthoredPlan[]
  feedback?: string
  /** `feedback` is the disagreements a debate left open, not Jev's verdict. */
  targeted?: boolean
  resumed?: boolean
}): string {
  const peers = listLabels(input.peerPlans.map(({ label }) => label))
  const ownPlan = input.resumed
    ? ''
    : `Your earlier draft:\n<own-plan>\n${input.ownPlan}\n</own-plan>\n\n`
  return `${planContract(CHECK_DISPUTES)}

You are reviewing peer plans from ${peers}. Compare them with your ${
    input.resumed ? 'last plan in this conversation' : 'own draft'
  }, correct weak assumptions,
adopt useful details, and return a revised standalone plan. Do not merely write a critique.

${taskBlock(input.task, input.resumed)}${ownPlan}${planBlocks(input.peerPlans, 'peer-plan')}${
    input.feedback === undefined
      ? ''
      : input.targeted
        ? `\n\nThe debate left these disagreements open. Settle each one in your revised plan, checking the repository where a claim is about it:\n<open-disagreements>\n${input.feedback}\n</open-disagreements>`
        : `\n\nJev identified remaining uncertainty. Use this typed feedback to target the revision:\n<jev-feedback>\n${input.feedback}\n</jev-feedback>`
  }`
}

/** `resumed` is for an agent continuing its own conversation: the task is left out. */
export function finalPlanPrompt(input: {
  task: string
  plans: readonly AuthoredPlan[]
  verdict: string
  /** In `debate` review: the disputes and Jev's rulings on them. */
  disputes?: string
  resumed?: boolean
}): string {
  return `${planContract(SETTLE_CONTRADICTIONS)}

Act as the final editor. Merge the best concrete parts of all the revised plans, guided by Jev's typed verdict.
Resolve contradictions explicitly. Return one self-contained execution plan—no discussion of the planning process,
no winner announcement, and no Jev commentary.

${taskBlock(input.task, input.resumed)}${planBlocks(input.plans, 'revised-plan')}

Jev verdict:
<jev-verdict>
${input.verdict}
</jev-verdict>${
    input.disputes === undefined
      ? ''
      : `

The agents' disagreements, and Jev's ruling on each. Follow a ruling unless the plans show it wrong:
<disputes>
${input.disputes}
</disputes>`
  }`
}

/** The format a critique answers in, shown to the critic. */
const CRITIQUE_FORMAT = `TARGET: <agent>
C1 [repo]: <claim about a file, symbol or export> — <why it matters>
C2: <claim about the design> — <why it matters>`

/**
 * Asks an agent for its objections to every peer plan, and nothing else: no
 * revision yet. `resumed` is for an agent continuing its own conversation,
 * which already holds the task and its own plan.
 */
export function critiquePrompt(input: {
  task: string
  ownPlan: string
  peerPlans: readonly (AuthoredPlan & { name: AgentName })[]
  resumed?: boolean
}): string {
  const ownPlan = input.resumed
    ? ''
    : `Your own draft, for reference:\n<own-plan>\n${input.ownPlan}\n</own-plan>\n\n`
  return `${planContract(CHECK_DISPUTES)}

Do not write a plan this time. Critique the peer plans below: find what is wrong in each, not what
is good. For each peer, write a TARGET line with its agent name, then at most ${String(MAX_OBJECTIONS)} numbered
objections, most important first:

${CRITIQUE_FORMAT}

Mark an objection [repo] only when it makes a claim about the repository that someone could check
by opening a file. Say why each objection matters after a dash. Raise only objections you would
defend; an author will accept or reject each one, and Jev will rule on the rejected ones.

${taskBlock(input.task, input.resumed)}${ownPlan}${planBlocks(input.peerPlans, 'peer-plan')}`
}

/** An objection as the author it is aimed at sees it. */
export interface ReceivedObjection extends Objection {
  criticLabel: string
}

/**
 * Asks an author to accept or reject every objection to its plan, then to
 * return its revised plan. `resumed` leaves out the task and its own plan.
 */
export function replyPrompt(input: {
  task: string
  ownPlan: string
  objections: readonly ReceivedObjection[]
  resumed?: boolean
}): string {
  const ownPlan = input.resumed ? '' : `Your plan:\n<own-plan>\n${input.ownPlan}\n</own-plan>\n\n`
  const received =
    input.objections.length === 0
      ? 'No objections were raised against your plan. Return it, improved where you see fit.'
      : `The other agents raised these objections against your plan:
<objections>
${input.objections
  .map(
    ({ id, criticLabel, claim, why, repo }) =>
      `${id} (${criticLabel}${repo ? ', about the repository' : ''}): ${claim}${why ? ` — ${why}` : ''}`,
  )
  .join('\n')}
</objections>

Answer every objection on its own line, by its id: ACCEPT when it is right, and change your plan to
match; REJECT when it is wrong, with the reason. Open a file before rejecting a claim about the
repository. Then return your revised plan, complete and standalone.`
  return `${planContract(CHECK_DISPUTES)}

${received}

Answer in this format:
<replies>
<id>: ACCEPT — <what you changed>
<id>: REJECT — <why the objection is wrong>
</replies>
<revised-plan>
<your whole revised plan>
</revised-plan>

${taskBlock(input.task, input.resumed)}${ownPlan}`.trimEnd()
}

/** A disputed claim for a checker, with who made it and who rejected it. */
export interface ClaimToCheck {
  id: string
  claim: string
  criticLabels: readonly string[]
  authorLabel: string
  rejections: readonly string[]
}

/**
 * Asks an agent that reads the repository to settle disputed claims about it,
 * one answer per claim. `resumed` leaves out the task.
 */
export function claimCheckPrompt(input: {
  task: string
  claims: readonly ClaimToCheck[]
  resumed?: boolean
}): string {
  return `You are checking disputed claims about this repository, not planning. Work read-only.
Open the files each claim is about and answer on one line per claim, by its id:

D1: CONFIRM — <file:symbol that shows the claim is true>
D2: REFUTE — <file:symbol that shows it is false>
D3: UNKNOWN — <what you looked at>

Answer UNKNOWN whenever the files do not settle it. Return nothing else.

${taskBlock(input.task, input.resumed)}<claims>
${input.claims
  .map(
    ({ id, claim, criticLabels, authorLabel, rejections }) =>
      `${id}: ${claim}\n  Raised by ${listLabels(criticLabels)} against ${authorLabel}'s plan.${
        rejections.length > 0 ? ` ${authorLabel} rejected it: ${rejections.join(' / ')}` : ''
      }`,
  )
  .join('\n')}
</claims>`
}

/** Below this confidence, a ruling leaves its dispute open. */
export const SETTLED = 0.65

const RULING_TEXT: Record<DisputeRuling['choice'], (critics: string, author: string) => string> = {
  critic: (critics) => `${critics}'s objection holds`,
  author: (_critics, author) => `${author}'s position holds`,
  unclear: () => 'the material does not settle it',
}

/** Whether a dispute is settled: Jev ruled for a side, and with at least `SETTLED` confidence. */
export function isSettled(ruling: DisputeRuling | undefined): boolean {
  return ruling !== undefined && ruling.choice !== 'unclear' && ruling.confidence >= SETTLED
}

/** `D1 (Codex → Claude): <claim>. Jev: Claude's position holds (0.72). Check: REFUTE src/jev.ts.` */
function disputeLine(
  dispute: Dispute,
  ruling: DisputeRuling | undefined,
  label: (name: AgentName) => string,
): string {
  const critics = listLabels(dispute.critics.map(label))
  const author = label(dispute.target)
  const parts = [`${dispute.id} (${critics} → ${author}): ${dispute.claim.replace(/\.$/, '')}.`]
  parts.push(
    ruling
      ? `Jev: ${RULING_TEXT[ruling.choice](critics, author)} (${ruling.confidence.toFixed(2)}).`
      : 'Jev: not judged.',
  )
  if (dispute.check) {
    const evidence = dispute.check.evidence ? ` ${dispute.check.evidence.replace(/\.$/, '')}` : ''
    parts.push(`Check: ${dispute.check.result.toUpperCase()}${evidence}.`)
  }
  return parts.join(' ')
}

/** Every dispute and Jev's ruling on it, one per line, for the final merge. */
export function disputeSummary(input: {
  disputes: readonly Dispute[]
  overflow: readonly Dispute[]
  rulings: readonly DisputeRuling[]
  label: (name: AgentName) => string
}): string {
  const ruling = (id: string) => input.rulings.find((candidate) => candidate.id === id)
  return [...input.disputes, ...input.overflow]
    .map((dispute) => disputeLine(dispute, ruling(dispute.id), input.label))
    .join('\n')
}

const SCORE_NAMES = {
  completeness: 'completeness',
  feasibility: 'feasibility and grounding in the repository',
  riskCoverage: 'coverage of edge cases, tests and rollout risks',
} as const

/**
 * What a second pass after a debate aims at: the disputes Jev's rulings left
 * open, and those past the cap that it never judged. With none open, a note
 * saying so and the weakest of Jev's scores, since Jev asking for another pass
 * can also mean something is missing that nobody disputed.
 */
export function disputeFeedback(input: {
  disputes: readonly Dispute[]
  overflow: readonly Dispute[]
  verdict: JevVerdict
  label: (name: AgentName) => string
}): string {
  const rulings = input.verdict.disputes ?? []
  const ruling = (id: string) => rulings.find((candidate) => candidate.id === id)
  const open = input.disputes.filter((dispute) => !isSettled(ruling(dispute.id)))
  const lines = [
    ...open.map((dispute) => disputeLine(dispute, ruling(dispute.id), input.label)),
    ...input.overflow.map((dispute) => disputeLine(dispute, undefined, input.label)),
  ]
  if (lines.length > 0) return lines.join('\n')
  const name = (Object.keys(SCORE_NAMES) as (keyof typeof SCORE_NAMES)[]).reduce((weakest, next) =>
    input.verdict[next] < input.verdict[weakest] ? next : weakest,
  )
  return `No disagreement is left open, but Jev still expects another pass to improve the plan. Its weakest score is ${SCORE_NAMES[name]}: ${input.verdict[name].toFixed(1)} of 3. Strengthen that.`
}
