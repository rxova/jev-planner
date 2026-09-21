/** A plan and the agent that wrote it, as a prompt shows it. */
export interface AuthoredPlan {
  label: string
  plan: string
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
    .map(({ label, plan }) => `${label}'s plan:\n<${tag} author="${label}">\n${plan}\n</${tag}>`)
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
    input.feedback
      ? `\n\nJev identified remaining uncertainty. Use this typed feedback to target the revision:\n<jev-feedback>\n${input.feedback}\n</jev-feedback>`
      : ''
  }`
}

/** `resumed` is for an agent continuing its own conversation: the task is left out. */
export function finalPlanPrompt(input: {
  task: string
  plans: readonly AuthoredPlan[]
  verdict: string
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
</jev-verdict>`
}
