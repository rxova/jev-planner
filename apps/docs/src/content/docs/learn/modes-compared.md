---
title: Modes compared
description: One real task planned four ways — fast, balanced, ultra, and ultra with the debate review — with the time, rounds, calls, Jev's verdicts and how good each plan was.
sidebar:
  order: 2
---

The same brief, a visual redesign of this documentation site, planned four times on 2026-09-22.
Every run used the default two agents, Codex on GPT-5.6-Sol at medium effort and Claude, judged by
`jev-1.13.0`. The four ran at the same time on one machine, so their timings include some contention.
The plans were scored afterwards, out of 10, by checking their claims against the repository.

This is one task and one run of each mode, not a benchmark: read it as an example of how the modes
behave, not a promise of how they rank.

|                                                     | Debate                                                                                                           | Ultra                                                                                                          | Fast                                                              | Balanced                                                                           |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Command**                                         | `--mode ultra --review-mode debate --claim-checks`                                                               | `--mode ultra`                                                                                                 | `--mode fast`                                                     | `--mode balanced`                                                                  |
| **Plan score**                                      | **8.5** (1st)                                                                                                    | 8 (2nd)                                                                                                        | 7.5 (3rd)                                                         | 6.5 (4th)                                                                          |
| **Total time**                                      | 7m 00s                                                                                                           | 6m 36s                                                                                                         | **4m 34s**                                                        | 8m 40s                                                                             |
| **Rounds**                                          | 5: drafts, critiques, replies, review, merge                                                                     | 4: drafts, review, review, merge                                                                               | **2**: drafts, merge                                              | 4: drafts, review, review, merge                                                   |
| **Round times**                                     | 139s, 72s, 75s, 86s, 49s                                                                                         | 178s, 80s, 85s, 54s                                                                                            | 221s, 54s                                                         | 239s, 113s, 116s, 53s                                                              |
| **Agent calls**                                     | 9                                                                                                                | 7                                                                                                              | **3**                                                             | 7                                                                                  |
| **Jev calls**                                       | 2                                                                                                                | 2                                                                                                              | 3: two drafts alone, one joint                                    | 3                                                                                  |
| **Jev's last verdict: stands alone / another pass** | **0.59 / 0.56**                                                                                                  | 0.34 / 0.67                                                                                                    | 0.42 / 0.61                                                       | 0.39 / 0.66                                                                        |
| **What the mode did**                               | The full debate, then one more review                                                                            | Two reviews, as ultra may run                                                                                  | Accepted no draft alone, so merged both                           | Jev asked for both reviews (0.66, then 0.70), so it skipped nothing                |
| **The debate**                                      | 10 objections, 8 about the repository; all 10 accepted, so no disputes for Jev to rule on and no claims to check | —                                                                                                              | —                                                                 | —                                                                                  |
| **Strongest points**                                | The most accurate about the repository: a real 360 px test, no component overrides, docs text untouched          | The most thorough: warnings as asides with their `.md` twins kept valid, a table fallback only if 360 px fails | Tight and conservative; its mode figures are pinned to the README | An explicit 360 px test; a Copy button hidden without JavaScript                   |
| **Weakest points**                                  | Puts the social-card redraw in scope                                                                             | Rewrites the tagline and edits docs text; relies on a 412 px phone for the 360 px check                        | No real 360 px test; adds a cost line whose numbers vary          | Overrides Starlight's hero, the riskiest choice; reorders the pinned keyboard test |
| **In short**                                        | Best plan, about 6% slower than ultra                                                                            | A close second                                                                                                 | Best value: half a point behind ultra in two-thirds of the time   | Slowest and weakest this time                                                      |

## What it shows

- **Rounds are the time.** Codex was the slower agent in every round both agents ran, and each round
  waited for it. Fast was quickest because it ran two rounds, even though it still paid for a merge.
- **Balanced only saves time when Jev says a round would not help.** Here Jev asked for another pass
  at 0.66 and then 0.70, both above the 0.65 cutoff, so balanced ran every round ultra did.
- **Fast's bar for a draft alone was too high.** At the time fast answered with a draft alone only
  when Jev rated it 0.7 or more. On this task no plan in any run, drafted or reviewed, scored above
  0.59, so fast fell back to merging its two drafts. The bar is now 0.5.
- **The debate paid off through its critiques, not its rulings.** The objections were concrete —
  Starlight's `hero.image.html` is a plain string, the Playwright phone is 412 px wide, pixel
  snapshots would be flaky — and the replies fixed every one. Because both agents accepted every
  objection, nothing was left for Jev to rule on or for [`--claim-checks`](../guides/debate-review.md)
  to verify.

See [how it works](how-it-works.md#fast-balanced-or-ultra-in-short) for what each mode runs, and
[cost and data flow](../guides/cost-and-data-flow.md) for what it bills.
