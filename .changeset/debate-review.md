---
'jev-planner': minor
---

Add an experimental debate review: `--review-mode debate` (`reviewMode: 'debate'`) runs the first review as critiques and replies. Each agent lists numbered objections to every other plan, each author accepts or rejects the ones to its own and revises it, and Jev rules on the rejected ones in its usual call; later passes and the final synthesis work from those rulings. `--claim-checks` (`claimChecks: true`) has agent CLIs check the disputed claims about the repository before Jev rules. The rounds folder gains `objections.json`, `replies.json` and `disputes.json`. New in the API: `ReviewMode`, `Objection`, `Reply`, `ClaimCheck`, `Dispute`, `DisputeRuling`, `RoundDebate`, `PlanningAgent.readsRepository`, `JevVerdict.disputes`, and `PlanResult.debate`. `PlanRound.stage` gains `critique`, `reply` and `check`, and `PlanCost.reviewMode` is always set, so an exhaustive `switch` on the stage needs the new cases.
