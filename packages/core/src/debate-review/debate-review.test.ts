import { describe, expect, it, vi } from 'vitest'
import { Planner } from '../orchestrator/orchestrator.js'
import {
  straggler,
  FakeAgent,
  FakeJev,
  task,
  type Answer,
} from '../orchestrator/orchestrator.fixtures.js'
import type { PlanRound } from '../orchestrator/orchestrator.types.js'
import { PlanRun } from '../plan-run/plan-run.js'
import { debateReview } from './debate-review.js'

describe('Planner debate review', () => {
  const reader = (name: string, responses: (string | Answer)[]) =>
    Object.assign(new FakeAgent(name, responses), { readsRepository: true })
  const critique =
    'TARGET: claude\nC1 [repo]: runRound is missing — the plan calls it\nC2: too broad — split it'
  const claudeReply =
    '<replies>\ncodex:claude:C1: REJECT — it exists in orchestrator.ts\ncodex:claude:C2: ACCEPT — split\n</replies>\n<revised-plan>claude revised</revised-plan>'
  const ruling = { disputes: [{ id: 'D1', choice: 'author' as const, confidence: 0.8 }] }

  it('critiques, answers, lets Jev rule on the disputes and hands the rulings to the merge', async () => {
    const codex = new FakeAgent('codex', ['codex draft', critique, 'codex revised, no replies'])
    const claude = new FakeAgent('claude', [
      'claude draft',
      'TARGET: codex\nC1: no tests — risky',
      claudeReply,
      'final plan',
    ])
    const jev = new FakeJev([ruling])
    const rounds: PlanRound[] = []
    const stages: string[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      mode: 'ultra',
      reviewMode: 'debate',
      onRound: (round) => {
        rounds.push(round)
      },
      onStage: (message) => stages.push(message),
    })

    expect(claude.prompts[1]).toContain('<peer-plan author="Codex" agent="codex">')
    expect(claude.prompts[1]).toContain('TARGET: <agent>')
    expect(claude.prompts[2]).toContain(
      'codex:claude:C1 (Codex, about the repository): runRound is missing — the plan calls it',
    )
    expect(codex.prompts[2]).toContain('claude:codex:C1 (Claude): no tests — risky')
    expect(rounds.map(({ stage }) => stage)).toEqual(['draft', 'critique', 'review', 'final'])
    expect(rounds[1]).toMatchObject({
      plans: { codex: 'codex draft', claude: 'claude draft' },
      artifacts: { codex: critique },
      debate: {
        objections: [
          { id: 'codex:claude:C1' },
          { id: 'codex:claude:C2' },
          { id: 'claude:codex:C1' },
        ],
      },
    })
    expect(rounds[2]).toMatchObject({
      plans: { codex: 'codex revised, no replies', claude: 'claude revised' },
      artifacts: { claude: claudeReply },
      verdict: ruling,
    })
    const [dispute] = jev.input?.disputes ?? []
    expect(dispute).toMatchObject({ id: 'D1', target: 'claude', critics: ['codex'], repo: true })
    expect(result.debate).toMatchObject({
      replies: [
        { id: 'codex:claude:C1', decision: 'reject' },
        { id: 'codex:claude:C2', decision: 'accept' },
      ],
      unanswered: ['claude:codex:C1'],
      disputes: [{ id: 'D1' }],
      overflow: [],
    })
    expect(result.debate?.claimChecks).toBeUndefined()
    expect(claude.prompts[3]).toContain(
      "D1 (Codex → Claude): runRound is missing. Judge: Claude's position holds (0.80).",
    )
    expect(stages).toContain('Re-evaluating the revised plans and 1 disagreements with Jev…')
    expect(result.cost).toEqual({
      mode: 'ultra',
      reviewMode: 'debate',
      reviewRounds: 1,
      synthesized: true,
      agentCalls: 7,
      judgeCalls: 1,
      dropped: [],
    })
  })

  it('debates only when Jev asks, then aims a second pass at the disputes left open', async () => {
    const codex = new FakeAgent('codex', ['codex draft', critique, 'codex revised', 'codex pass'])
    const claude = new FakeAgent('claude', [
      'claude draft',
      'No objections.',
      claudeReply,
      'claude pass',
      'final',
    ])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      {
        needsAnotherPassProbability: 0.9,
        disputes: [{ id: 'D1', choice: 'unclear', confidence: 0.9 }],
      },
      { needsAnotherPassProbability: 0.1 },
    ])

    const result = await new Planner([codex, claude], jev).plan({ ...task, reviewMode: 'debate' })

    expect(codex.prompts[3]).toContain('<open-disagreements>')
    expect(codex.prompts[3]).toContain(
      'D1 (Codex → Claude): runRound is missing. Judge: the material does not settle it (0.90).',
    )
    expect(codex.prompts[3]).not.toContain('<judge-feedback>')
    expect(jev.inputs[2]?.disputes).toBeUndefined()
    // The merge still sees the debate's rulings, not the pass verdict's lack of them.
    expect(claude.prompts[4]).toContain('Judge: the material does not settle it (0.90).')
    expect(result.cost).toMatchObject({ reviewMode: 'debate', reviewRounds: 2, agentCalls: 9 })
  })

  it("aims the second pass at Jev's weakest score when the debate settled everything", async () => {
    const codex = new FakeAgent('codex', ['codex draft', critique, 'codex revised', 'codex pass'])
    const claude = new FakeAgent('claude', [
      'claude draft',
      'No objections.',
      claudeReply,
      'claude pass',
      'final',
    ])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      { needsAnotherPassProbability: 0.9, feasibility: 1.5, ...ruling },
      { needsAnotherPassProbability: 0.1 },
    ])

    await new Planner([codex, claude], jev).plan({ ...task, reviewMode: 'debate' })

    expect(codex.prompts[3]).toContain(
      'Its weakest score is feasibility and grounding in the repository: 1.5 of 3.',
    )
  })

  it('skips the debate, like a cross-review, when Jev does not ask for one', async () => {
    const codex = new FakeAgent('codex', ['codex draft'])
    const claude = new FakeAgent('claude', ['claude draft', 'final'])

    const result = await new Planner([codex, claude], new FakeJev()).plan({
      ...task,
      reviewMode: 'debate',
    })

    expect(result.debate).toBeUndefined()
    expect(claude.prompts[1]).not.toContain('<disputes>')
    expect(result.cost).toMatchObject({ reviewMode: 'debate', reviewRounds: 0, agentCalls: 3 })
  })

  it('has a reader check the disputed repository claims before Jev rules', async () => {
    const codex = reader('codex', ['codex draft', critique, 'codex revised'])
    const claude = reader('claude', [
      'claude draft',
      'No objections.',
      claudeReply,
      'D1: REFUTE — orchestrator.ts:runRound does not exist',
      'final',
    ])
    const jev = new FakeJev([ruling])
    const rounds: PlanRound[] = []

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      mode: 'ultra',
      claimChecks: true,
      onRound: (round) => {
        rounds.push(round)
      },
    })

    // Codex raised it, so the only reader left to check it is its author.
    expect(claude.prompts[3]).toContain('D1: runRound is missing')
    expect(claude.prompts[3]).toContain(
      "Raised by Codex against Claude's plan. Claude rejected it: it exists in orchestrator.ts",
    )
    expect(rounds.map(({ stage }) => stage)).toEqual([
      'draft',
      'critique',
      'reply',
      'check',
      'final',
    ])
    expect(rounds[2]?.verdict).toBeUndefined()
    const check = {
      checker: 'claude',
      result: 'refute',
      evidence: 'orchestrator.ts:runRound does not exist',
    }
    expect(rounds[3]).toMatchObject({
      artifacts: { claude: 'D1: REFUTE — orchestrator.ts:runRound does not exist' },
      debate: { claimChecks: 'ran', disputes: [{ id: 'D1', check }] },
      verdict: ruling,
    })
    expect(jev.input?.disputes?.[0]?.check).toEqual(check)
    expect(claude.prompts[4]).toContain('Check: REFUTE orchestrator.ts:runRound does not exist.')
    expect(result.cost).toMatchObject({ reviewMode: 'debate', agentCalls: 8 })
  })

  it('skips the claim checks without two agents that read the repository', async () => {
    const codex = reader('codex', ['codex draft', critique, 'codex revised'])
    const claude = new FakeAgent('claude', ['claude draft', 'No objections.', claudeReply, 'final'])
    const stages: string[] = []
    const rounds: PlanRound[] = []

    const result = await new Planner([codex, claude], new FakeJev([ruling])).plan({
      ...task,
      mode: 'ultra',
      claimChecks: true,
      onStage: (message) => stages.push(message),
      onRound: (round) => {
        rounds.push(round)
      },
    })

    expect(stages).toContain('Claim checks skipped: needs two agents that read the repository')
    expect(rounds.map(({ stage }) => stage)).toEqual(['draft', 'critique', 'review', 'final'])
    expect(result.debate?.claimChecks).toBe('skipped')
  })

  it('skips the claim checks when no disputed claim is about the repository', async () => {
    const codex = reader('codex', ['codex draft', 'TARGET: claude\nC1: too broad', 'codex revised'])
    const claude = reader('claude', [
      'claude draft',
      'No objections.',
      'codex:claude:C1: reject — it is not\n## Revised plan\nclaude revised',
      'final',
    ])
    const stages: string[] = []
    const jev = new FakeJev()

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      mode: 'ultra',
      claimChecks: true,
      onStage: (message) => stages.push(message),
    })

    expect(stages).toContain('Claim checks skipped: no disputed claim about the repository')
    expect(result.debate).toMatchObject({ claimChecks: 'skipped', disputes: [{ repo: false }] })
    // Jev gave no rulings: the merge reports the dispute as not judged.
    expect(claude.prompts[3]).toContain('D1 (Codex → Claude): too broad. Judge: not judged.')
  })

  it('keeps an author’s plan when the round stops waiting for its reply', async () => {
    const codex = new FakeAgent('codex', ['codex draft', critique, straggler()])
    const claude = new FakeAgent('claude', [
      'claude draft',
      'TARGET: codex\nC1: x',
      claudeReply,
      'final',
    ])
    const jev = new FakeJev([
      { needsAnotherPassProbability: 0.9 },
      { needsAnotherPassProbability: 0.1 },
    ])

    const result = await new Planner([codex, claude], jev).plan({
      ...task,
      reviewMode: 'debate',
      stragglerGraceMs: 1,
    })

    expect(result.drafts).toEqual({ codex: 'codex draft', claude: 'claude revised' })
    expect(result.debate?.unanswered).toEqual(['claude:codex:C1'])
    expect(result.cost.dropped).toEqual(['codex'])
  })

  it('continues sessions with the shorter debate prompts', async () => {
    const codex = reader('codex', ['codex draft', critique, 'codex revised'])
    const claude = reader('claude', [
      'claude draft',
      'No objections.',
      claudeReply,
      'D1: confirm',
      'final',
    ])

    await new Planner([codex, claude], new FakeJev([ruling])).plan({
      ...task,
      mode: 'ultra',
      claimChecks: true,
    })

    expect(codex.requests[1]?.resumePrompt).not.toContain('<own-plan>')
    expect(codex.requests[2]?.resumePrompt).not.toContain('<own-plan>')
    expect(claude.requests[3]?.resumePrompt).not.toContain('<task>')
    expect(claude.requests[3]?.prompt).toContain('<task>')
  })

  it('rejects claim checks outside a debate, and a debate with no review round, before any call', async () => {
    const codex = new FakeAgent('codex', [])
    const claude = new FakeAgent('claude', [])
    const planner = new Planner([codex, claude], new FakeJev())

    await expect(
      planner.plan({ ...task, reviewMode: 'standard', claimChecks: true }),
    ).rejects.toThrow("Claim checks run in the debate review: set reviewMode to 'debate'")
    await expect(planner.plan({ ...task, claimChecks: true, maxReviewRounds: 0 })).rejects.toThrow(
      'The debate review is a review round: maxReviewRounds must be at least 1',
    )
    expect(codex.prompts).toEqual([])
  })
})

describe('debateReview', () => {
  const reader = (name: string, responses: string[]) =>
    Object.assign(new FakeAgent(name, responses), { readsRepository: true })
  const critique =
    'TARGET: claude\nC1 [repo]: runRound is missing — the plan calls it\nC2: too broad — split it'
  const rejectsBoth =
    '<replies>\ncodex:claude:C1: REJECT — it exists\ncodex:claude:C2: REJECT — it is one change\n</replies>\n<revised-plan>claude revised</revised-plan>'
  const start = (agents: FakeAgent[], jev: FakeJev) =>
    new PlanRun(
      agents,
      jev,
      { ...task, claimChecks: true },
      {
        mode: 'ultra',
        reviewMode: 'debate',
        graceMs: 0,
      },
    )
  const draftsOf = (agents: FakeAgent[]) =>
    agents.map((agent) => ({ agent, plan: `${agent.name} draft` }))

  it('checks only the repository claims: a dispute about the plan itself keeps no check', async () => {
    const codex = reader('codex', [critique, 'codex, no replies'])
    const claude = reader('claude', ['No objections.', rejectsBoth, 'D1: CONFIRM — it is there'])
    const jev = new FakeJev()

    const outcome = await debateReview(start([codex, claude], jev), draftsOf([codex, claude]))

    expect(outcome.disputes.map(({ id, repo }) => ({ id, repo }))).toEqual([
      { id: 'D1', repo: true },
      { id: 'D2', repo: false },
    ])
    expect(outcome.disputes[0]?.check).toMatchObject({ checker: 'claude', result: 'confirm' })
    expect(outcome.disputes[1]).not.toHaveProperty('check')
    expect(jev.input?.disputes?.[1]).not.toHaveProperty('check')
  })

  it('treats an author missing from the reply round as having answered nothing', async () => {
    const codex = new FakeAgent('codex', [critique, 'codex, no replies'])
    const claude = new FakeAgent('claude', ['No objections.', rejectsBoth])
    const run = start([codex, claude], new FakeJev())
    const runRound = run.runRound.bind(run)
    let calls = 0
    vi.spyOn(run, 'runRound').mockImplementation(async (roundCalls) => {
      calls += 1
      const drafts = await runRound(roundCalls)
      // The reply round comes back without Claude's answer.
      return calls === 2 ? drafts.filter(({ agent }) => agent !== claude) : drafts
    })

    const outcome = await debateReview(run, draftsOf([codex, claude]))

    expect(outcome.drafts.find(({ agent }) => agent === claude)?.plan).toBe('claude draft')
    expect(outcome.record.replies).toEqual([])
    expect(outcome.record.unanswered).toEqual(['C1', 'C2'].map((id) => `codex:claude:${id}`))
  })

  it('records a claim as unknown when its checker is missing from the check round', async () => {
    const codex = reader('codex', [critique, 'codex, no replies'])
    const claude = reader('claude', ['No objections.', rejectsBoth, 'D1: CONFIRM — it is there'])
    const run = start([codex, claude], new FakeJev())
    const runRound = run.runRound.bind(run)
    let calls = 0
    vi.spyOn(run, 'runRound').mockImplementation(async (roundCalls) => {
      calls += 1
      const drafts = await runRound(roundCalls)
      return calls === 3 ? [] : drafts
    })

    const outcome = await debateReview(run, draftsOf([codex, claude]))

    expect(outcome.record.claimChecks).toBe('ran')
    expect(outcome.disputes[0]?.check).toEqual({
      checker: 'claude',
      result: 'unknown',
      evidence: '',
    })
    expect(outcome.disputes[1]).not.toHaveProperty('check')
  })
})
