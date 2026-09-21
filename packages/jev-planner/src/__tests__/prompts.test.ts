import { describe, expect, it } from 'vitest'
import { finalPlanPrompt, initialPlanPrompt, revisionPrompt } from '../prompts.js'

describe('planning prompts', () => {
  it('delimits the task and names the peers', () => {
    const prompt = initialPlanPrompt('ship it', ['Claude'])
    expect(prompt).toContain('<task>\nship it\n</task>')
    expect(prompt).toContain('in a collaboration with Claude.')
    expect(initialPlanPrompt('t', ['Claude', 'GLM', 'Kimi'])).toContain(
      'in a collaboration with Claude, GLM and Kimi.',
    )
    expect(initialPlanPrompt('t', [])).toContain('in a collaboration with .')
  })

  it('asks cross-reviewers for a standalone revision against every peer', () => {
    const prompt = revisionPrompt({
      task: 'task',
      ownPlan: 'mine',
      peerPlans: [
        { label: 'Claude', plan: 'theirs' },
        { label: 'GLM', plan: 'others' },
      ],
    })
    expect(prompt).toContain('peer plans from Claude and GLM')
    expect(prompt).toContain('return a revised standalone plan')
    expect(prompt).toContain('<own-plan>\nmine\n</own-plan>')
    expect(prompt).toContain('<peer-plan author="Claude">\ntheirs\n</peer-plan>')
    expect(prompt).toContain('<peer-plan author="GLM">\nothers\n</peer-plan>')
    expect(prompt).not.toContain('<jev-feedback>')
  })

  it("adds Jev's feedback to a second revision", () => {
    const prompt = revisionPrompt({
      task: 'task',
      ownPlan: 'mine',
      peerPlans: [{ label: 'Codex', plan: 'theirs' }],
      feedback: '{"x":1}',
    })
    expect(prompt).toContain('<jev-feedback>\n{"x":1}\n</jev-feedback>')
  })

  it('tells the finalizer to hide orchestration details', () => {
    const prompt = finalPlanPrompt({
      task: 'task',
      plans: [
        { label: 'Codex', plan: 'a' },
        { label: 'Claude', plan: 'b' },
      ],
      verdict: '{}',
    })
    expect(prompt).toContain('no winner announcement')
    expect(prompt).toContain('<revised-plan author="Codex">\na\n</revised-plan>')
    expect(prompt).toContain('<revised-plan author="Claude">\nb\n</revised-plan>')
    expect(prompt).toContain('<jev-verdict>\n{}\n</jev-verdict>')
  })

  it('tells every planner to ask rather than invent scope for a vague task', () => {
    const sentence =
      'If the task is a placeholder or too vague to act on, say so and list the clarifying questions instead of inventing scope.'
    const plans = [{ label: 'Codex', plan: 'b' }]
    const prompts = [
      initialPlanPrompt('task', ['Codex']),
      revisionPrompt({ task: 'task', ownPlan: 'a', peerPlans: plans }),
      finalPlanPrompt({ task: 'task', plans, verdict: '{}' }),
    ]
    for (const prompt of prompts) expect(prompt).toContain(sentence)
  })

  it('asks only the draft to explore the repository, and later stages to open a file for a reason', () => {
    const plans = [{ label: 'Codex', plan: 'b' }]
    const draft = initialPlanPrompt('task', ['Codex'])
    const revision = revisionPrompt({ task: 'task', ownPlan: 'a', peerPlans: plans })
    const final = finalPlanPrompt({ task: 'task', plans, verdict: '{}' })
    const explore = 'Inspect the repository before deciding.'
    expect(draft).toContain(explore)
    expect(revision).not.toContain(explore)
    expect(final).not.toContain(explore)
    expect(revision).toContain(
      'Open a file only to check a claim on which the plans disagree, or one you are unsure of.',
    )
    expect(final).toContain('Open a file only to settle a contradiction between them.')
    for (const prompt of [draft, revision, final]) {
      expect(prompt).toContain('Make the plan specific to files and symbols that exist.')
    }
  })
})
