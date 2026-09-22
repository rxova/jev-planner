import { describe, expect, it } from 'vitest'
import {
  claimCheckPrompt,
  critiquePrompt,
  disputeFeedback,
  disputeSummary,
  finalPlanPrompt,
  initialPlanPrompt,
  isSettled,
  replyPrompt,
  revisionPrompt,
  SETTLED,
} from '../prompts.js'
import type { Dispute, Verdict } from '../types.js'

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
    expect(prompt).not.toContain('<judge-feedback>')
  })

  it("adds Jev's feedback to a second revision", () => {
    const prompt = revisionPrompt({
      task: 'task',
      ownPlan: 'mine',
      peerPlans: [{ label: 'Codex', plan: 'theirs' }],
      feedback: '{"x":1}',
    })
    expect(prompt).toContain('<judge-feedback>\n{"x":1}\n</judge-feedback>')
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
    expect(prompt).toContain('<judge-verdict>\n{}\n</judge-verdict>')
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

  it('leaves the task and own plan out of a resumed revision, and the task out of a resumed synthesis', () => {
    const peerPlans = [{ label: 'Claude', plan: 'theirs' }]
    const full = revisionPrompt({ task: 'the task', ownPlan: 'mine', peerPlans })
    const resumed = revisionPrompt({ task: 'the task', ownPlan: 'mine', peerPlans, resumed: true })
    expect(full).toContain('Compare them with your own draft')
    expect(resumed).toContain('Compare them with your last plan in this conversation')
    expect(resumed).not.toContain('<task>')
    expect(resumed).not.toContain('<own-plan>')
    expect(resumed).toContain('<peer-plan author="Claude">\ntheirs\n</peer-plan>')

    const final = { task: 'the task', plans: peerPlans, verdict: '{}' }
    expect(finalPlanPrompt(final)).toContain('<task>\nthe task\n</task>')
    const resumedFinal = finalPlanPrompt({ ...final, resumed: true })
    expect(resumedFinal).not.toContain('<task>')
    expect(resumedFinal).toContain('<revised-plan author="Claude">\ntheirs\n</revised-plan>')
    expect(resumedFinal).toContain('<judge-verdict>\n{}\n</judge-verdict>')
  })
})

const dispute = (id: string, overrides: Partial<Dispute> = {}): Dispute => ({
  id,
  target: 'claude',
  critics: ['codex'],
  objections: [],
  claim: `claim ${id}.`,
  reasons: [],
  rejections: [],
  repo: false,
  ...overrides,
})

const label = (name: string) => `${name.charAt(0).toUpperCase()}${name.slice(1)}`

const verdict: Verdict = {
  strongerPlan: 'tie',
  strongerPlanConfidence: 0.2,
  finalizer: 'claude',
  finalizerConfidence: 0.8,
  completeness: 2.5,
  completenessConfidence: 0.9,
  feasibility: 2.9,
  feasibilityConfidence: 0.9,
  riskCoverage: 2.7,
  riskCoverageConfidence: 0.8,
  needsAnotherPassProbability: 0.9,
  standsAloneProbability: 0.1,
  model: 'jev-test',
}

describe('debate prompts', () => {
  it('asks for objections to each peer by agent name, not for a plan', () => {
    const input = {
      task: 'task',
      ownPlan: 'mine',
      peerPlans: [{ name: 'claude', label: 'Claude', plan: 'theirs' }],
    }
    const prompt = critiquePrompt(input)
    expect(prompt).toContain('Do not write a plan this time.')
    expect(prompt).toContain('then at most 5 numbered')
    expect(prompt).toContain('<own-plan>\nmine\n</own-plan>')
    expect(prompt).toContain('<peer-plan author="Claude" agent="claude">\ntheirs\n</peer-plan>')
    const resumed = critiquePrompt({ ...input, resumed: true })
    expect(resumed).not.toContain('<own-plan>')
    expect(resumed).not.toContain('<task>')
    expect(resumed).toContain('<peer-plan')
  })

  it('asks an author to answer each objection by id, then for its whole revised plan', () => {
    const input = {
      task: 'task',
      ownPlan: 'mine',
      objections: [
        {
          id: 'codex:claude:C1',
          critic: 'codex',
          criticLabel: 'Codex',
          target: 'claude',
          claim: 'a',
          why: 'b',
          repo: true,
        },
        {
          id: 'codex:claude:C2',
          critic: 'codex',
          criticLabel: 'Codex',
          target: 'claude',
          claim: 'c',
          why: '',
          repo: false,
        },
      ],
    }
    const prompt = replyPrompt(input)
    expect(prompt).toContain(
      'codex:claude:C1 (Codex, about the repository): a — b\ncodex:claude:C2 (Codex): c\n',
    )
    expect(prompt).toContain('<revised-plan>')
    expect(prompt).toContain('<own-plan>\nmine\n</own-plan>')
    expect(replyPrompt({ ...input, resumed: true })).not.toContain('<own-plan>')
    expect(replyPrompt({ ...input, objections: [] })).toContain(
      'No objections were raised against your plan.',
    )
  })

  it('asks a checker for one verdict per claim, with who raised and rejected it', () => {
    const claims = [
      {
        id: 'D1',
        claim: 'x',
        criticLabels: ['Codex', 'GLM'],
        authorLabel: 'Claude',
        rejections: ['no', 'nope'],
      },
      { id: 'D2', claim: 'y', criticLabels: ['Codex'], authorLabel: 'Claude', rejections: [] },
    ]
    const prompt = claimCheckPrompt({ task: 'task', claims })
    expect(prompt).toContain(
      "D1: x\n  Raised by Codex and GLM against Claude's plan. Claude rejected it: no / nope",
    )
    expect(prompt).toContain("D2: y\n  Raised by Codex against Claude's plan.\n</claims>")
    expect(prompt).toContain('<task>')
    expect(claimCheckPrompt({ task: 'task', claims, resumed: true })).not.toContain('<task>')
  })

  it('aims a targeted revision at the open disagreements instead of the verdict', () => {
    const prompt = revisionPrompt({
      task: 'task',
      ownPlan: 'mine',
      peerPlans: [{ label: 'Claude', plan: 'theirs' }],
      feedback: 'D1 …',
      targeted: true,
    })
    expect(prompt).toContain('<open-disagreements>\nD1 …\n</open-disagreements>')
    expect(prompt).not.toContain('<judge-feedback>')
  })

  it('hands the merge the disputes after the verdict, only when there are some', () => {
    const input = { task: 'task', plans: [{ label: 'Codex', plan: 'p' }], verdict: '{}' }
    expect(finalPlanPrompt({ ...input, disputes: 'D1 …' })).toMatch(
      /<\/judge-verdict>\n\n.*\n<disputes>\nD1 …\n<\/disputes>$/,
    )
    expect(finalPlanPrompt(input)).not.toContain('<disputes>')
  })

  it('settles a dispute only on a side, and with enough confidence', () => {
    expect(isSettled(undefined)).toBe(false)
    expect(isSettled({ id: 'D1', choice: 'unclear', confidence: 1 })).toBe(false)
    expect(isSettled({ id: 'D1', choice: 'critic', confidence: SETTLED - 0.01 })).toBe(false)
    expect(isSettled({ id: 'D1', choice: 'critic', confidence: SETTLED })).toBe(true)
  })

  it('summarizes every dispute with its ruling and its check', () => {
    const summary = disputeSummary({
      disputes: [
        dispute('D1', {
          critics: ['codex', 'glm'],
          check: { checker: 'kimi', result: 'refute', evidence: 'src/a.ts.' },
        }),
        dispute('D2', { check: { checker: 'kimi', result: 'unknown', evidence: '' } }),
      ],
      overflow: [dispute('D3')],
      rulings: [
        { id: 'D1', choice: 'critic', confidence: 0.9 },
        { id: 'D2', choice: 'author', confidence: 0.7 },
      ],
      label,
    })
    expect(summary.split('\n')).toEqual([
      "D1 (Codex and Glm → Claude): claim D1. Judge: Codex and Glm's objection holds (0.90). Check: REFUTE src/a.ts.",
      "D2 (Codex → Claude): claim D2. Judge: Claude's position holds (0.70). Check: UNKNOWN.",
      'D3 (Codex → Claude): claim D3. Judge: not judged.',
    ])
  })

  it('feeds a second pass the open and unjudged disputes, or the weakest score', () => {
    const disputes = [dispute('D1'), dispute('D2')]
    const settled = {
      ...verdict,
      disputes: [{ id: 'D1', choice: 'author' as const, confidence: 0.9 }],
    }
    expect(
      disputeFeedback({ disputes, overflow: [dispute('D9')], verdict: settled, label }).split('\n'),
    ).toEqual([
      'D2 (Codex → Claude): claim D2. Judge: not judged.',
      'D9 (Codex → Claude): claim D9. Judge: not judged.',
    ])
    expect(
      disputeFeedback({ disputes: [dispute('D1')], overflow: [], verdict: settled, label }),
    ).toBe(
      'No disagreement is left open, but the judge still expects another pass to improve the plan. Its weakest score is completeness: 2.5 of 3. Strengthen that.',
    )
    expect(
      disputeFeedback({
        disputes: [],
        overflow: [],
        verdict: { ...verdict, riskCoverage: 1 },
        label,
      }),
    ).toContain('coverage of edge cases, tests and rollout risks: 1.0 of 3.')
  })
})
