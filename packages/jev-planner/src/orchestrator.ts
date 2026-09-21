import { finalPlanPrompt, initialPlanPrompt, revisionPrompt } from './prompts.js'
import type { JevJudge, PlanOptions, PlanResult, PlanningAgent } from './types.js'

export class Planner {
  constructor(
    private readonly codex: PlanningAgent,
    private readonly claude: PlanningAgent,
    private readonly jev: JevJudge,
  ) {}

  async plan(options: PlanOptions): Promise<PlanResult> {
    const stage = options.onStage ?? (() => undefined)
    const request = (prompt: string) => ({
      prompt,
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
    })

    stage('Drafting independent plans with Codex and Claude…')
    const [codexDraft, claudeDraft] = await Promise.all([
      this.codex.generate(request(initialPlanPrompt(options.task, 'Claude'))),
      this.claude.generate(request(initialPlanPrompt(options.task, 'Codex'))),
    ])

    stage('Cross-reviewing the two drafts…')
    let [codexRevised, claudeRevised] = await Promise.all([
      this.codex.generate(
        request(
          revisionPrompt({
            task: options.task,
            ownPlan: codexDraft,
            peerPlan: claudeDraft,
            peer: 'Claude',
          }),
        ),
      ),
      this.claude.generate(
        request(
          revisionPrompt({
            task: options.task,
            ownPlan: claudeDraft,
            peerPlan: codexDraft,
            peer: 'Codex',
          }),
        ),
      ),
    ])

    stage('Asking Jev for typed quality and routing decisions…')
    let verdict = await this.jev.judge({
      task: options.task,
      codexPlan: codexRevised,
      claudePlan: claudeRevised,
      ...(options.jevModel ? { model: options.jevModel } : {}),
    })

    if (verdict.needsAnotherPassProbability >= 0.65 && (options.maxReviewRounds ?? 2) > 1) {
      stage('Jev requested another cross-review pass…')
      const feedback = JSON.stringify(verdict, null, 2)
      ;[codexRevised, claudeRevised] = await Promise.all([
        this.codex.generate(
          request(
            revisionPrompt({
              task: options.task,
              ownPlan: codexRevised,
              peerPlan: claudeRevised,
              peer: 'Claude',
              feedback,
            }),
          ),
        ),
        this.claude.generate(
          request(
            revisionPrompt({
              task: options.task,
              ownPlan: claudeRevised,
              peerPlan: codexRevised,
              peer: 'Codex',
              feedback,
            }),
          ),
        ),
      ])
      stage('Re-evaluating the revised plans with Jev…')
      verdict = await this.jev.judge({
        task: options.task,
        codexPlan: codexRevised,
        claudePlan: claudeRevised,
        ...(options.jevModel ? { model: options.jevModel } : {}),
      })
    }

    const finalizerName = options.finalizer ?? verdict.finalizer
    const finalizer = finalizerName === 'codex' ? this.codex : this.claude
    stage(`Synthesizing the final plan with ${finalizerName === 'codex' ? 'Codex' : 'Claude'}…`)

    const finalPlan = await finalizer.generate(
      request(
        finalPlanPrompt({
          task: options.task,
          codexPlan: codexRevised,
          claudePlan: claudeRevised,
          verdict: JSON.stringify(verdict, null, 2),
        }),
      ),
    )

    return {
      plan: finalPlan,
      verdict,
      finalizer: finalizerName,
      drafts: { codex: codexRevised, claude: claudeRevised },
    }
  }
}
