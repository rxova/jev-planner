import type { AgentRequest, PlanningAgent } from '../provider/provider.types.js'
import type { PlanJudge, Verdict } from '../questions/questions.types.js'

export const verdict: Verdict = {
  strongerPlan: 'tie',
  strongerPlanConfidence: 0.2,
  finalizer: 'claude',
  finalizerConfidence: 0.8,
  completeness: 2.8,
  completenessConfidence: 0.9,
  feasibility: 2.9,
  feasibilityConfidence: 0.9,
  riskCoverage: 2.7,
  riskCoverageConfidence: 0.8,
  needsAnotherPassProbability: 0.1,
  standsAloneProbability: 0.1,
  model: 'jev-test',
}

/** An answer that takes its time, or never comes; the argument is the live request. */
export type Answer = (request: AgentRequest) => Promise<string>

/** Never answers, and reports the abort when the round stops waiting for it. */
export const straggler =
  (aborts: string[] = []): Answer =>
  (request) =>
    new Promise<string>((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        aborts.push('aborted')
        reject(new Error('stopped'))
      })
    })

/** Answers, but only after the grace window has long passed. */
export const late =
  (plan: string): Answer =>
  () =>
    new Promise<string>((resolve) => setTimeout(() => resolve(plan), 20))

export class FakeAgent implements PlanningAgent {
  readonly prompts: string[] = []
  readonly requests: AgentRequest[] = []

  readonly label: string

  constructor(
    readonly name: string,
    private readonly responses: (string | Answer)[],
  ) {
    this.label = `${name.charAt(0).toUpperCase()}${name.slice(1)}`
  }

  async generate(request: AgentRequest): Promise<string> {
    this.prompts.push(request.prompt)
    this.requests.push(request)
    request.onProgress?.(`working on call ${String(this.prompts.length)}`)
    const response = this.responses.shift()
    if (!response) throw new Error(`No fake ${this.name} response`)
    return typeof response === 'string' ? response : response(request)
  }
}

export class FakeJev implements PlanJudge {
  readonly name = 'Jev'
  readonly inputs: Parameters<PlanJudge['judge']>[0][] = []

  constructor(private readonly verdicts: Partial<Verdict>[] = [{}]) {}

  get input(): Parameters<PlanJudge['judge']>[0] | undefined {
    return this.inputs.at(-1)
  }

  async judge(input: Parameters<PlanJudge['judge']>[0]): Promise<Verdict> {
    this.inputs.push(input)
    return { ...verdict, ...(this.verdicts.at(this.inputs.length - 1) ?? this.verdicts.at(-1)) }
  }
}

export const task = { task: 'Add caching', cwd: '/tmp', timeoutMs: 1_000 } as const
