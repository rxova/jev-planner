import { describe, expect, it } from 'vitest'
import { finalPlanPrompt, initialPlanPrompt, revisionPrompt } from '../prompts.js'

describe('planning prompts', () => {
  it('delimits the task', () => {
    expect(initialPlanPrompt('ship it', 'Claude')).toContain('<task>\nship it\n</task>')
  })

  it('asks cross-reviewers for a standalone revision', () => {
    const prompt = revisionPrompt({
      task: 'task',
      ownPlan: 'mine',
      peerPlan: 'theirs',
      peer: 'Claude',
    })
    expect(prompt).toContain('return a revised standalone plan')
    expect(prompt).toContain('<own-plan>\nmine\n</own-plan>')
    expect(prompt).toContain('<peer-plan>\ntheirs\n</peer-plan>')
  })

  it('tells the finalizer to hide orchestration details', () => {
    const prompt = finalPlanPrompt({
      task: 'task',
      codexPlan: 'a',
      claudePlan: 'b',
      verdict: '{}',
    })
    expect(prompt).toContain('no winner announcement')
    expect(prompt).toContain('<jev-verdict>\n{}\n</jev-verdict>')
  })

  it('tells every planner to ask rather than invent scope for a vague task', () => {
    const sentence =
      'If the task is a placeholder or too vague to act on, say so and list the clarifying questions instead of inventing scope.'
    const prompts = [
      initialPlanPrompt('task', 'Codex'),
      revisionPrompt({ task: 'task', ownPlan: 'a', peerPlan: 'b', peer: 'Codex' }),
      finalPlanPrompt({ task: 'task', codexPlan: 'a', claudePlan: 'b', verdict: '{}' }),
    ]
    for (const prompt of prompts) expect(prompt).toContain(sentence)
  })
})
