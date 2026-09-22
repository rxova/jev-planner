import type { PlanningAgent } from '../provider/provider.types.js'
import type { Verdict } from '../questions/questions.types.js'
import type { Accepted, Draft, Generate, Pending, RoundCall } from './round.types.js'

/**
 * In `fast` mode, at or above this the judge is accepting one draft, judged alone, as the answer. Lower
 * than synthesis's `STANDS_ALONE`: in real runs the judge rated no plan above 0.59, so 0.7 never let a draft through.
 */
export const ACCEPTED_ALONE = 0.5

/** A round never returns fewer plans than this: below it, there is no collaboration left to judge. */
const MIN_PLANS = 2

/** Each draft's plan, keyed by its agent's name: how a round is reported. */
export const byName = (drafts: readonly Draft[]): Record<string, string> =>
  Object.fromEntries(drafts.map(({ agent, plan }) => [agent.name, plan]))

const pendingOf = (calls: readonly RoundCall[]): Pending[] =>
  calls.map((call) => ({ call, controller: new AbortController() }))

/** Half of the round's calls, and at least one: once they are in, the grace starts. */
const quorumOf = (pending: readonly Pending[]) => Math.max(1, Math.ceil(pending.length / 2))

const asError = (error: unknown) => (error instanceof Error ? error : new Error(String(error)))

/**
 * Every agent's plan for one round, in parallel.
 *
 * With a grace, the round stops waiting `graceMs` after half of the agents
 * have answered and aborts the rest, so one slow agent no longer sets the pace
 * of the round. An aborted agent keeps its plan from the round before, and an
 * agent whose plan the round cannot do without — a draft nobody can stand in
 * for, when dropping it would leave fewer than two plans — is waited for
 * anyway. Rejections are the caller's, as `Promise.all` would raise them,
 * except from a call this round aborted itself.
 */
export function round(
  calls: readonly RoundCall[],
  generate: Generate,
  graceMs: number,
  onDrop: (agent: PlanningAgent) => void,
): Promise<Draft[]> {
  if (graceMs <= 0) {
    return Promise.all(
      calls.map(async ({ agent, prompt, later }) => ({
        agent,
        plan: await generate(agent, prompt, later),
      })),
    )
  }

  return new Promise<Draft[]>((resolve, reject) => {
    const pending = pendingOf(calls)
    const quorum = quorumOf(pending)
    let answered = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      callback()
    }

    const settleIfDone = (): void => {
      if (pending.some((entry) => entry.plan === undefined && entry.dropped === undefined)) return
      finish(() => {
        resolve(
          pending.flatMap(({ call, plan }) => {
            const answer = plan ?? call.fallback
            return answer === undefined ? [] : [{ agent: call.agent, plan: answer }]
          }),
        )
      })
    }

    const cutOff = (): void => {
      // What the round would answer with if it waited: one plan per call,
      // answered or not. Only dropping a call with nothing to fall back on
      // takes one away.
      let remaining = pending.length
      for (const entry of pending) {
        if (entry.plan !== undefined || entry.dropped !== undefined) continue
        if (entry.call.fallback === undefined) {
          if (remaining - 1 < MIN_PLANS) continue
          remaining -= 1
        }
        entry.dropped = true
        entry.controller.abort()
        onDrop(entry.call.agent)
      }
      settleIfDone()
    }

    for (const entry of pending) {
      generate(entry.call.agent, entry.call.prompt, entry.call.later, entry.controller.signal).then(
        (plan) => {
          if (settled || entry.dropped !== undefined) return
          entry.plan = plan
          answered += 1
          if (timer === undefined && answered >= quorum) timer = setTimeout(cutOff, graceMs)
          settleIfDone()
        },
        (error: unknown) => {
          // A call this round aborted was already accounted for.
          if (entry.dropped !== undefined) return
          finish(() => {
            reject(asError(error))
          })
        },
      )
    }
  })
}

/**
 * The draft round of `fast` mode: every agent drafts at once, and each draft
 * is handed to `judgeSolo` as it arrives, one at a time, in arrival order.
 * The first one whose verdict stands alone is accepted: the calls still
 * running are aborted and reported to `onDrop` with it, and the round
 * resolves with every draft that arrived, those still waiting to be judged
 * included. With none accepted, it resolves once every call has answered
 * and every draft has been judged.
 *
 * The grace works as in `round`: once half the agents have answered, the
 * rest get `graceMs`, and the round never cuts below two drafts. It is kept
 * apart from `round` so that `balanced` and `ultra` run exactly the code
 * they always have. An agent or the judge failing before a draft is accepted
 * aborts the calls still running and rejects the round.
 */
export function firstAccepted(
  calls: readonly RoundCall[],
  generate: Generate,
  graceMs: number,
  onDrop: (agent: PlanningAgent, accepted?: Draft) => void,
  judgeSolo: (draft: Draft) => Promise<Verdict>,
): Promise<{ drafts: Draft[]; accepted?: Accepted }> {
  return new Promise((resolve, reject) => {
    const pending = pendingOf(calls)
    const quorum = quorumOf(pending)
    const queue: Draft[] = []
    let answered = 0
    let judging = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false

    const running = () =>
      pending.filter((entry) => entry.plan === undefined && entry.dropped === undefined)
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      callback()
    }
    const resolveWith = (accepted?: Accepted): void => {
      finish(() => {
        resolve({
          drafts: pending.flatMap(({ call, plan }) =>
            plan === undefined ? [] : [{ agent: call.agent, plan }],
          ),
          ...(accepted ? { accepted } : {}),
        })
      })
    }
    const fail = (error: unknown): void => {
      for (const entry of running()) {
        entry.dropped = true
        entry.controller.abort()
      }
      finish(() => {
        reject(asError(error))
      })
    }

    const judgeNext = (): void => {
      if (settled || judging) return
      const draft = queue.shift()
      if (!draft) {
        if (running().length === 0) resolveWith()
        return
      }
      judging = true
      judgeSolo(draft).then((verdict) => {
        judging = false
        if (settled) return
        if (verdict.standsAloneProbability < ACCEPTED_ALONE) {
          judgeNext()
          return
        }
        for (const entry of running()) {
          entry.dropped = true
          entry.controller.abort()
          onDrop(entry.call.agent, draft)
        }
        resolveWith({ draft, verdict })
      }, fail)
    }

    const cutOff = (): void => {
      // Every call is a draft, and a draft has nothing to stand in for it.
      let remaining = pending.length
      for (const entry of running()) {
        if (remaining - 1 < MIN_PLANS) continue
        remaining -= 1
        entry.dropped = true
        entry.controller.abort()
        onDrop(entry.call.agent)
      }
      judgeNext()
    }

    for (const entry of pending) {
      const { agent, prompt, later } = entry.call
      generate(agent, prompt, later, entry.controller.signal).then(
        (plan) => {
          if (settled || entry.dropped !== undefined) return
          entry.plan = plan
          answered += 1
          if (graceMs > 0 && timer === undefined && answered >= quorum) {
            timer = setTimeout(cutOff, graceMs)
          }
          queue.push({ agent, plan })
          judgeNext()
        },
        (error: unknown) => {
          // A call this round aborted was already accounted for.
          if (entry.dropped !== undefined) return
          fail(error)
        },
      )
    }
  })
}
