const PLAN_CONTRACT = `
You are designing an implementation plan, not implementing code. Work read-only.
Inspect the repository before deciding. Make the plan specific to files and symbols that exist.
Call out assumptions and unresolved questions. Prefer a small, verifiable sequence of changes.
Include architecture, edge cases, tests, validation, and rollout/compatibility concerns.
Keep the response under 1,500 words. Return Markdown only.`

export function initialPlanPrompt(task: string, peer: 'Codex' | 'Claude'): string {
  return `${PLAN_CONTRACT}

You are the first planner in a collaboration with ${peer}. Produce your strongest independent plan.

Task:
<task>
${task}
</task>`
}

export function revisionPrompt(input: {
  task: string
  ownPlan: string
  peerPlan: string
  peer: 'Codex' | 'Claude'
  feedback?: string
}): string {
  return `${PLAN_CONTRACT}

You are reviewing a peer plan from ${input.peer}. Compare it with your own draft, correct weak assumptions,
adopt useful details, and return a revised standalone plan. Do not merely write a critique.

Task:
<task>
${input.task}
</task>

Your earlier draft:
<own-plan>
${input.ownPlan}
</own-plan>

Peer draft:
<peer-plan>
${input.peerPlan}
</peer-plan>${
    input.feedback
      ? `\n\nJev identified remaining uncertainty. Use this typed feedback to target the revision:\n<jev-feedback>\n${input.feedback}\n</jev-feedback>`
      : ''
  }`
}

export function finalPlanPrompt(input: {
  task: string
  codexPlan: string
  claudePlan: string
  verdict: string
}): string {
  return `${PLAN_CONTRACT}

Act as the final editor. Merge the best concrete parts of both revised plans, guided by Jev's typed verdict.
Resolve contradictions explicitly. Return one self-contained execution plan—no discussion of the planning process,
no winner announcement, and no Jev commentary.

Task:
<task>
${input.task}
</task>

Codex revised plan:
<codex-plan>
${input.codexPlan}
</codex-plan>

Claude revised plan:
<claude-plan>
${input.claudePlan}
</claude-plan>

Jev verdict:
<jev-verdict>
${input.verdict}
</jev-verdict>`
}
