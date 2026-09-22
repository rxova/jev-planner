import {
  assignChecks,
  buildDisputes,
  parseChecks,
  parseCritique,
  parseReply,
} from '../debate/debate.js'
import { claimCheckPrompt, critiquePrompt, replyPrompt } from '../prompts/prompts.js'
import { byName } from '../round/round.js'
import type { Reply, RoundDebate } from '../debate/debate.types.js'
import type { PlanRun } from '../plan-run/plan-run.js'
import type { Draft } from '../round/round.types.js'
import type { DebateOutcome } from './debate-review.types.js'

/**
 * The debate review: each agent critiques the others, each author answers
 * the objections to its plan and revises it, the rejected objections become
 * disputes, and the judge rules on them along with its usual verdict.
 */
export async function debateReview(run: PlanRun, drafts: readonly Draft[]): Promise<DebateOutcome> {
  const { task } = run.options
  const peersOf = (own: Draft) => drafts.filter((draft) => draft !== own)
  run.stage(`Collecting critiques of the ${String(drafts.length)} drafts…`)
  const critiques = await run.runRound(
    drafts.map((own) => {
      const input = {
        task,
        ownPlan: own.plan,
        peerPlans: peersOf(own).map(({ agent, plan }) => ({
          name: agent.name,
          label: agent.label,
          plan,
        })),
      }
      return {
        agent: own.agent,
        fallback: '',
        prompt: critiquePrompt(input),
        later: run.later((resumed) => critiquePrompt({ ...input, resumed })),
      }
    }),
  )
  const objections = critiques.flatMap(
    ({ agent, plan }) =>
      parseCritique(
        agent.name,
        plan,
        drafts.filter((draft) => draft.agent !== agent).map((draft) => draft.agent),
      ).objections,
  )
  await run.report('critique', byName(drafts), {
    artifacts: byName(critiques),
    debate: { objections },
  })

  run.stage('Asking each author to answer the objections to its plan…')
  const received = (own: Draft) =>
    objections
      .filter((objection) => objection.target === own.agent.name)
      .map((objection) => ({ ...objection, criticLabel: run.label(objection.critic) }))
  const answers = await run.runRound(
    drafts.map((own) => {
      const input = { task, ownPlan: own.plan, objections: received(own) }
      return {
        agent: own.agent,
        fallback: '',
        prompt: replyPrompt(input),
        later: run.later((resumed) => replyPrompt({ ...input, resumed })),
      }
    }),
  )
  const replies: Reply[] = []
  const revised = drafts.map((own) => {
    const answer = answers.find(({ agent }) => agent === own.agent)?.plan ?? ''
    const ids = received(own).map(({ id }) => id)
    const parsed = parseReply(own.agent.name, answer, ids, own.plan)
    replies.push(...parsed.replies)
    return { agent: own.agent, plan: parsed.plan }
  })
  const unanswered = objections
    .map(({ id }) => id)
    .filter((id) => !replies.some((reply) => reply.id === id))
  const built = buildDisputes(objections, replies)
  let { disputes } = built
  const { overflow } = built
  let claimChecks: RoundDebate['claimChecks']
  const record = (): RoundDebate => ({
    objections,
    replies,
    unanswered,
    disputes,
    overflow,
    ...(claimChecks ? { claimChecks } : {}),
  })

  let checks: Draft[] | undefined
  if (run.options.claimChecks) {
    const checkers = revised
      .filter(({ agent }) => agent.readsRepository === true)
      .map(({ agent }) => agent.name)
    const assigned = assignChecks(
      disputes.filter(({ repo }) => repo),
      checkers,
    )
    if (checkers.length < 2) {
      claimChecks = 'skipped'
      run.stage('Claim checks skipped: needs two agents that read the repository')
    } else if (assigned.size === 0) {
      claimChecks = 'skipped'
      run.stage('Claim checks skipped: no disputed claim about the repository')
    } else {
      await run.report('reply', byName(revised), { artifacts: byName(answers), debate: record() })
      run.stage(
        `Checking ${String([...assigned.values()].flat().length)} disputed claims against the repository…`,
      )
      const toCheck = [...assigned].map(([checker, claims]) => ({
        agent: run.agent(checker),
        claims,
        input: {
          task,
          claims: claims.map((dispute) => ({
            id: dispute.id,
            claim: dispute.claim,
            criticLabels: dispute.critics.map((critic) => run.label(critic)),
            authorLabel: run.label(dispute.target),
            rejections: dispute.rejections,
          })),
        },
      }))
      checks = await run.runRound(
        toCheck.map(({ agent, input }) => ({
          agent,
          fallback: '',
          prompt: claimCheckPrompt(input),
          later: run.later((resumed) => claimCheckPrompt({ ...input, resumed })),
        })),
      )
      const results = new Map(
        toCheck.flatMap(({ agent, claims }) => [
          ...parseChecks(
            agent.name,
            checks?.find((check) => check.agent === agent)?.plan ?? '',
            claims.map(({ id }) => id),
          ),
        ]),
      )
      disputes = disputes.map((dispute) => {
        const check = results.get(dispute.id)
        return check ? { ...dispute, check } : dispute
      })
      claimChecks = 'ran'
    }
  }

  run.stage(
    disputes.length > 0
      ? `Re-evaluating the revised plans and ${String(disputes.length)} disagreements with ${run.judgeName}…`
      : `Re-evaluating the revised plans with ${run.judgeName}…`,
  )
  const verdict = await run.judge(revised, 'review', disputes)
  await run.report(checks ? 'check' : 'review', byName(revised), {
    verdict,
    artifacts: byName(checks ?? answers),
    debate: record(),
  })
  return { drafts: revised, verdict, record: record(), disputes, overflow }
}
