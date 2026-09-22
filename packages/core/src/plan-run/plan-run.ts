import { revisionPrompt } from '../prompts/prompts.js'
import { round } from '../round/round.js'
import type { Dispute } from '../debate/debate.types.js'
import type {
  PlanCost,
  PlanOptions,
  PlanRound,
  RunTimings,
} from '../orchestrator/orchestrator.types.js'
import type { AgentName, AgentSession, PlanningAgent } from '../provider/provider.types.js'
import type { PlanJudge, Verdict } from '../questions/questions.types.js'
import type { Draft, Generate, Later, RoundCall } from '../round/round.types.js'
import type { RunSettings } from './plan-run.types.js'

/** The agent of that name, or an error naming the agents there are. */
export function findAgent(agents: readonly PlanningAgent[], name: AgentName): PlanningAgent {
  const agent = agents.find((candidate) => candidate.name === name)
  if (!agent) {
    throw new Error(
      `"${name}" is not one of this planner's agents: ${agents.map((a) => a.name).join(', ')}`,
    )
  }
  return agent
}

/**
 * One call of `Planner.plan`: what it has spent, how long each round took,
 * each agent's session, and the calls every phase of the run makes through it.
 */
export class PlanRun {
  readonly cost: PlanCost
  readonly timings: RunTimings = { totalMs: 0, rounds: [] }
  /** Whether each agent continues one conversation through the run. */
  readonly resume: boolean
  readonly stage: (message: string) => void

  // Each round is timed from the end of the last one's report to its own, so
  // the time spent writing a round out is counted in neither.
  private readonly runStart = performance.now()
  private roundStart = this.runStart
  private agentMs: Record<AgentName, number> = {}
  private judgeMs: number | undefined
  private rounds = 0
  private readonly sessions: Map<PlanningAgent, AgentSession>

  constructor(
    readonly agents: readonly PlanningAgent[],
    private readonly planJudge: PlanJudge,
    readonly options: PlanOptions,
    private readonly settings: RunSettings,
  ) {
    this.cost = {
      mode: settings.mode,
      reviewMode: settings.reviewMode,
      reviewRounds: 0,
      synthesized: false,
      agentCalls: 0,
      judgeCalls: 0,
      dropped: [],
    }
    this.stage = options.onStage ?? (() => undefined)
    // One conversation per agent, for this run only: a second run on the same
    // planner starts afresh.
    this.resume = options.resume ?? true
    this.sessions = new Map(this.resume ? agents.map((agent) => [agent, {}]) : [])
  }

  get judgeName(): string {
    return this.planJudge.name
  }

  agent(name: AgentName): PlanningAgent {
    return findAgent(this.agents, name)
  }

  label(name: AgentName): string {
    return this.agent(name).label
  }

  /** The later-call marker, with the shorter prompt when the agent continues its session. */
  later(prompt: (resumed: true | undefined) => string): Later {
    return { resumePrompt: this.resume ? prompt(true) : undefined }
  }

  /** Ends the round: records its timings, hands it to `onRound`, and starts the next one's clock. */
  async report(
    stageName: PlanRound['stage'],
    plans: Record<AgentName, string>,
    extra: Pick<PlanRound, 'verdict' | 'selected' | 'artifacts' | 'debate'> = {},
  ): Promise<void> {
    this.rounds += 1
    const roundTimings = {
      totalMs: performance.now() - this.roundStart,
      agents: this.agentMs,
      ...(this.judgeMs === undefined ? {} : { judgeMs: this.judgeMs }),
    }
    this.timings.rounds.push({ round: this.rounds, stage: stageName, ...roundTimings })
    await this.options.onRound?.({
      round: this.rounds,
      stage: stageName,
      plans,
      ...(extra.verdict ? { verdict: extra.verdict } : {}),
      timings: roundTimings,
      ...(extra.selected ? { selected: extra.selected } : {}),
      ...(extra.artifacts ? { artifacts: extra.artifacts } : {}),
      ...(extra.debate ? { debate: extra.debate } : {}),
    })
    this.roundStart = performance.now()
    this.agentMs = {}
    this.judgeMs = undefined
  }

  /** Stops the run's clock. */
  finish(): void {
    this.timings.totalMs = performance.now() - this.runStart
  }

  readonly generate: Generate = (agent, prompt, later, signal) => {
    this.cost.agentCalls += 1
    return this.timed(
      () => agent.generate(this.request(agent, prompt, later, signal)),
      (ms) => {
        // A call its round stopped waiting for belongs to no round's timings.
        if (signal?.aborted !== true) this.agentMs[agent.name] = ms
      },
    )
  }

  runRound(calls: readonly RoundCall[]): Promise<Draft[]> {
    return round(calls, this.generate, this.settings.graceMs, (agent) => {
      this.cost.dropped.push(agent.name)
      this.stage(`${agent.label} is still working; the round goes on without it…`)
    })
  }

  /** A cross-review: each agent revises its own plan against every other one. */
  revise(drafts: readonly Draft[], feedback?: string, targeted?: true): Promise<Draft[]> {
    return this.runRound(
      drafts.map((own) => {
        const input = {
          task: this.options.task,
          ownPlan: own.plan,
          peerPlans: drafts
            .filter((draft) => draft !== own)
            .map((draft) => ({ label: draft.agent.label, plan: draft.plan })),
          ...(feedback ? { feedback } : {}),
          ...(targeted ? { targeted } : {}),
        }
        return {
          agent: own.agent,
          fallback: own.plan,
          prompt: revisionPrompt(input),
          later: this.later((resumed) => revisionPrompt({ ...input, resumed })),
        }
      }),
    )
  }

  judge(
    drafts: readonly Draft[],
    judged: 'solo' | 'draft' | 'review',
    disputes: readonly Dispute[] = [],
  ): Promise<Verdict> {
    this.cost.judgeCalls += 1
    return this.timed(
      () =>
        this.planJudge.judge({
          task: this.options.task,
          stage: judged,
          plans: drafts.map(({ agent, plan }) => ({
            agent: agent.name,
            label: agent.label,
            plan,
          })),
          ...(disputes.length > 0 ? { disputes } : {}),
          ...(this.options.judgeModel ? { model: this.options.judgeModel } : {}),
        }),
      (ms) => {
        // `fast` judges several drafts alone in one round; the round shows them all.
        this.judgeMs = (this.judgeMs ?? 0) + ms
      },
    )
  }

  private request(agent: PlanningAgent, prompt: string, later: Later, signal?: AbortSignal) {
    const session = this.sessions.get(agent)
    const effort = later ? this.options.reviewEfforts?.[agent.name] : undefined
    const { onAgentProgress } = this.options
    return {
      prompt,
      ...(session
        ? { session, ...(later?.resumePrompt ? { resumePrompt: later.resumePrompt } : {}) }
        : {}),
      ...(effort === undefined ? {} : { effort }),
      cwd: this.options.cwd,
      timeoutMs: this.options.timeoutMs,
      ...(onAgentProgress
        ? {
            onProgress: (line: string) => {
              onAgentProgress(agent.name, line)
            },
          }
        : {}),
      ...(signal ? { signal } : {}),
    }
  }

  private async timed<T>(work: () => Promise<T>, record: (ms: number) => void): Promise<T> {
    const start = performance.now()
    const result = await work()
    record(performance.now() - start)
    return result
  }
}
