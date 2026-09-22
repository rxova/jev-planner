import { disputeSummary, finalPlanPrompt } from '../prompts/prompts.js'
import { byName } from '../round/round.js'
import type { PlanResult } from '../orchestrator/orchestrator.types.js'
import type { PlanRun } from '../plan-run/plan-run.js'
import type { Verdict } from '../questions/questions.types.js'
import type { Draft } from '../round/round.types.js'
import type { Reviewed } from './synthesis.types.js'

/** Above this, the judge is saying the strongest plan is final as it stands: no merge needed. */
const STANDS_ALONE = 0.7

/** The plan the judge called stronger, or the one it routed the merge to when it called them tied. */
const strongest = (drafts: readonly Draft[], verdict: Verdict): Draft | undefined =>
  drafts.find(({ agent }) => agent.name === verdict.strongerPlan) ??
  drafts.find(({ agent }) => agent.name === verdict.finalizer)

/**
 * The end of a run: adopt one plan as it stands when the run allows it, or
 * have the finalizer merge them all into one.
 */
export async function synthesize(
  run: PlanRun,
  { drafts, verdict, accepted, debated, finalizerOverride }: Reviewed,
): Promise<PlanResult> {
  const { options, cost } = run
  const debateRecord = debated ? { debate: debated.record } : {}

  // Outside fast mode, a plan may only be answered with whole once it has seen
  // every other agent's material: before a cross-review, the merge is the only
  // place that happens, so the synthesis call is not the run's to skip. A draft
  // fast mode accepted is the exception, and the mode's stated trade.
  const reviewed = cost.reviewRounds > 0
  const selected =
    reviewed && options.selectStronger
      ? drafts.find(({ agent }) => agent.name === verdict.strongerPlan)
      : undefined
  const standsAlone =
    reviewed &&
    cost.mode === 'balanced' &&
    finalizerOverride === undefined &&
    verdict.standsAloneProbability >= STANDS_ALONE
  const adopted =
    accepted?.draft ?? selected ?? (standsAlone ? strongest(drafts, verdict) : undefined)

  if (adopted) {
    run.stage(
      adopted === selected
        ? `${run.judgeName} rated ${adopted.agent.label}'s plan stronger; using it without a synthesis…`
        : `Adopting ${adopted.agent.label}'s plan: ${run.judgeName} judged it final as it stands…`,
    )
    await run.report('final', { [adopted.agent.name]: adopted.plan }, { verdict, selected: true })
    run.finish()
    return {
      plan: adopted.plan,
      verdict,
      finalizer: adopted.agent.name,
      selected: true,
      drafts: byName(drafts),
      ...debateRecord,
      timings: run.timings,
      cost,
    }
  }

  const finalizer = finalizerOverride ?? run.agent(verdict.finalizer)
  run.stage(`Synthesizing the final plan with ${finalizer.label}…`)

  const summary =
    debated && debated.disputes.length + debated.overflow.length > 0
      ? disputeSummary({
          disputes: debated.disputes,
          overflow: debated.overflow,
          rulings: debated.verdict.disputes ?? [],
          label: (name) => run.label(name),
        })
      : undefined
  const finalInput = {
    task: options.task,
    plans: drafts.map(({ agent, plan }) => ({ label: agent.label, plan })),
    verdict: JSON.stringify(verdict, null, 2),
    ...(summary === undefined ? {} : { disputes: summary }),
  }
  const finalPlan = await run.generate(
    finalizer,
    finalPlanPrompt(finalInput),
    run.later((resumed) => finalPlanPrompt({ ...finalInput, resumed })),
  )
  cost.synthesized = true

  await run.report('final', { [finalizer.name]: finalPlan }, { verdict })
  run.finish()

  return {
    plan: finalPlan,
    verdict,
    finalizer: finalizer.name,
    drafts: byName(drafts),
    ...debateRecord,
    timings: run.timings,
    cost,
  }
}
