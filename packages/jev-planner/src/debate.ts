import type { AgentName, ClaimCheck, Dispute, Objection, Reply } from './types.js'

/** An agent as a critique may name it: by name or by label. */
export interface Peer {
  name: AgentName
  label: string
}

/** Objections kept per critic and target; the prompt asks for no more. */
export const MAX_OBJECTIONS = 5

/** Disputes Jev rules on in one debate; the rest are reported as not judged. */
export const MAX_DISPUTES = 8

const TARGET = /^[\s#>*_-]*target\s*:\s*[*_`]*\s*(.+?)\s*[*_`]*\s*$/i
const OBJECTION = /^\s*[-*]?\s*\**C(\d+)\**\s*(\[[^\]]+\])?\s*\**\s*[:.)]\s*\**\s*(.+)$/i
const REASON = /\s+(?:—|–|--|-)\s+|\s*[—–]\s*/
const REPLY =
  /^\s*[-*]?\s*(?:R\s+)?\**([\w.-]+:[\w.-]+:C\d+)\**\s*:\s*\**(accept|reject)\**\s*(?:[—–:-]+\s*)?(.*)$/i
const CHECK =
  /^\s*[-*]?\s*\**(D\d+)\**\s*:\s*\**(confirm|refute|unknown)\**\s*(?:[—–:-]+\s*)?(.*)$/i

const lines = (text: string) => text.replace(/\r\n?/g, '\n').split('\n')

/** Splits `claim — reason` on the first dash that separates them. */
function claimAndReason(text: string): { claim: string; why: string } {
  const match = REASON.exec(text)
  if (!match) return { claim: text.trim(), why: '' }
  return {
    claim: text.slice(0, match.index).trim(),
    why: text.slice(match.index + match[0].length).trim(),
  }
}

/**
 * One critic's objections, by the agent each is aimed at. Lines that are not
 * objections, objections to an agent that is not a peer, repeated ids and
 * objections past `MAX_OBJECTIONS` per peer go to `prose`. Never throws.
 */
export function parseCritique(
  critic: AgentName,
  text: string,
  peers: readonly Peer[],
): { objections: Objection[]; prose: string } {
  const objections: Objection[] = []
  const prose: string[] = []
  const lookup = (value: string) => {
    const wanted = value.trim().toLowerCase()
    return peers.find(
      ({ name, label }) => name.toLowerCase() === wanted || label.toLowerCase() === wanted,
    )
  }
  // With a single peer, an objection outside any section can only be about it.
  let target: Peer | undefined = peers.length === 1 ? peers[0] : undefined
  for (const line of lines(text)) {
    const heading = TARGET.exec(line)
    if (heading?.[1] !== undefined) {
      target = lookup(heading[1])
      if (!target) prose.push(line.trim())
      continue
    }
    const match = OBJECTION.exec(line)
    const [, number, tag, body] = match ?? []
    const id = target && number !== undefined ? `${critic}:${target.name}:C${number}` : undefined
    if (
      !target ||
      id === undefined ||
      body === undefined ||
      objections.some((objection) => objection.id === id) ||
      objections.filter((objection) => objection.target === target?.name).length >= MAX_OBJECTIONS
    ) {
      if (line.trim()) prose.push(line.trim())
      continue
    }
    objections.push({
      id,
      critic,
      target: target.name,
      ...claimAndReason(body.replace(/\*+$/, '')),
      repo: tag?.toLowerCase() === '[repo]',
    })
  }
  return { objections, prose: prose.join('\n') }
}

/** The text between `<tag>` and `</tag>`, or to the end when it is never closed. */
function tagged(
  text: string,
  tag: string,
): { inner: string; start: number; end: number } | undefined {
  const open = new RegExp(`<${tag}>`, 'i').exec(text)
  if (!open) return undefined
  const from = open.index + open[0].length
  const close = new RegExp(`</${tag}>`, 'i').exec(text.slice(from))
  const to = close ? from + close.index : text.length
  return {
    inner: text.slice(from, to),
    start: open.index,
    end: close ? to + close[0].length : text.length,
  }
}

/**
 * An author's answers to the objections `ids`, and its revised plan.
 *
 * The plan is the `<revised-plan>` block, else what follows a `## Revised plan`
 * heading, else the text outside `<replies>` without the reply lines; when all
 * of those are empty it is `previousPlan`, so reply prose never stands in for
 * a plan. A reply to an id not in `ids` is ignored, and for a repeated id the
 * first reply wins. Never throws.
 */
export function parseReply(
  author: AgentName,
  text: string,
  ids: readonly string[],
  previousPlan: string,
): { replies: Reply[]; plan: string; prose: string } {
  const normalized = text.replace(/\r\n?/g, '\n')
  const planBlock = tagged(normalized, 'revised-plan')
  const withoutPlan = planBlock
    ? normalized.slice(0, planBlock.start) + normalized.slice(planBlock.end)
    : normalized
  const replyBlock = tagged(withoutPlan, 'replies')

  const replies: Reply[] = []
  const prose: string[] = []
  const known = new Map(ids.map((id) => [id.toLowerCase(), id]))
  const replyLines = new Set<string>()
  for (const line of lines(replyBlock ? replyBlock.inner : withoutPlan)) {
    const [, rawId, decision, reason] = REPLY.exec(line) ?? []
    const id = rawId === undefined ? undefined : known.get(rawId.toLowerCase())
    if (rawId !== undefined) replyLines.add(line)
    if (id === undefined || decision === undefined || reason === undefined) {
      if (replyBlock && rawId === undefined && line.trim()) prose.push(line.trim())
      continue
    }
    if (replies.some((reply) => reply.id === id)) continue
    replies.push({
      id,
      author,
      decision: decision.toLowerCase() === 'accept' ? 'accept' : 'reject',
      reason: reason.trim(),
    })
  }

  let plan = planBlock?.inner.trim() ?? ''
  if (!plan) {
    const heading = /^#{1,6}\s*revised plan\s*$/im.exec(withoutPlan)
    const rest = heading
      ? withoutPlan.slice(heading.index + heading[0].length)
      : replyBlock
        ? withoutPlan.slice(0, replyBlock.start) + withoutPlan.slice(replyBlock.end)
        : withoutPlan
    plan = lines(rest)
      .filter((line) => !replyLines.has(line))
      .join('\n')
      .trim()
  }
  return { replies, plan: plan || previousPlan, prose: prose.join('\n') }
}

/** Lowercase, punctuation and whitespace collapsed: two claims match only when these are equal. */
function normalizeClaim(claim: string): string {
  return claim
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

/**
 * The objections their authors rejected, as disputes for Jev: the same claim
 * against the same plan is merged, whoever raised it, and nothing else is.
 * Ranked by how many critics raised it, then claims about the repository,
 * then the order they were raised; the first `cap` are for Jev to rule on.
 */
export function buildDisputes(
  objections: readonly Objection[],
  replies: readonly Reply[],
  cap: number = MAX_DISPUTES,
): { disputes: Dispute[]; overflow: Dispute[] } {
  const rejected = new Map(
    replies.filter((reply) => reply.decision === 'reject').map((reply) => [reply.id, reply]),
  )
  const groups = new Map<string, Dispute>()
  for (const objection of objections) {
    const reply = rejected.get(objection.id)
    if (!reply) continue
    const key = `${objection.target}\n${normalizeClaim(objection.claim)}`
    const group = groups.get(key)
    if (group) {
      if (!group.critics.includes(objection.critic)) group.critics.push(objection.critic)
      group.objections.push(objection.id)
      if (objection.why) group.reasons.push(objection.why)
      if (reply.reason) group.rejections.push(reply.reason)
      group.repo ||= objection.repo
      continue
    }
    groups.set(key, {
      id: '',
      target: objection.target,
      critics: [objection.critic],
      objections: [objection.id],
      claim: objection.claim,
      reasons: objection.why ? [objection.why] : [],
      rejections: reply.reason ? [reply.reason] : [],
      repo: objection.repo,
    })
  }
  // A Map keeps the order claims were first raised, and the sort is stable: ties keep it.
  const ranked = [...groups.values()]
    .sort((a, b) => b.critics.length - a.critics.length || Number(b.repo) - Number(a.repo))
    .map((dispute, index) => ({ ...dispute, id: `D${String(index + 1)}` }))
  return { disputes: ranked.slice(0, cap), overflow: ranked.slice(cap) }
}

/**
 * Who checks each repository claim: an agent that reads the repository and did
 * not raise it, the author's peers before the author. Spread across the
 * checkers in turn; a claim nobody may check is left out.
 */
export function assignChecks(
  disputes: readonly Dispute[],
  checkers: readonly AgentName[],
): Map<AgentName, Dispute[]> {
  const assigned = new Map<AgentName, Dispute[]>()
  disputes.forEach((dispute, index) => {
    const eligible = checkers.filter((checker) => !dispute.critics.includes(checker))
    const peers = eligible.filter((checker) => checker !== dispute.target)
    const pool = peers.length > 0 ? peers : eligible
    const checker = pool[index % Math.max(1, pool.length)]
    if (checker === undefined) return
    assigned.set(checker, [...(assigned.get(checker) ?? []), dispute])
  })
  return assigned
}

/** A checker's answer for each id in `ids`; a missing or unparseable answer is `unknown`. */
export function parseChecks(
  checker: AgentName,
  text: string,
  ids: readonly string[],
): Map<string, ClaimCheck> {
  const checks = new Map<string, ClaimCheck>()
  for (const line of lines(text)) {
    const [, id, result, evidence] = CHECK.exec(line) ?? []
    if (id === undefined || result === undefined || evidence === undefined) continue
    const wanted = ids.find((candidate) => candidate.toLowerCase() === id.toLowerCase())
    if (wanted === undefined || checks.has(wanted)) continue
    checks.set(wanted, {
      checker,
      result: result.toLowerCase() as ClaimCheck['result'],
      evidence: evidence.trim(),
    })
  }
  for (const id of ids) {
    if (!checks.has(id)) checks.set(id, { checker, result: 'unknown', evidence: '' })
  }
  return checks
}
