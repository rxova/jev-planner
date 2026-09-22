import { describe, expect, it } from 'vitest'
import {
  assignChecks,
  buildDisputes,
  MAX_DISPUTES,
  MAX_OBJECTIONS,
  parseChecks,
  parseCritique,
  parseReply,
} from '../debate.js'
import type { Dispute, Objection, Reply } from '../types.js'

const claude = { name: 'claude', label: 'Claude' }
const glm = { name: 'glm', label: 'GLM' }

const objection = (overrides: Partial<Objection> & Pick<Objection, 'id'>): Objection => ({
  critic: 'codex',
  target: 'claude',
  claim: 'claim',
  why: '',
  repo: false,
  ...overrides,
})

const reject = (id: string, reason = 'no'): Reply => ({
  id,
  author: 'claude',
  decision: 'reject',
  reason,
})

describe('parseCritique', () => {
  it('reads objections by target, with the claim, the reason and the repo tag', () => {
    const text = [
      'Some opening prose.',
      'TARGET: claude',
      'C1 [repo]: runRound is not exported — the plan imports it',
      '- **C2**: the cap is too low -- eight disputes fit',
      '## Target: **GLM**',
      'C1. no tests for the parser',
    ].join('\r\n')

    const { objections, prose } = parseCritique('codex', text, [claude, glm])

    expect(objections).toEqual([
      {
        id: 'codex:claude:C1',
        critic: 'codex',
        target: 'claude',
        claim: 'runRound is not exported',
        why: 'the plan imports it',
        repo: true,
      },
      {
        id: 'codex:claude:C2',
        critic: 'codex',
        target: 'claude',
        claim: 'the cap is too low',
        why: 'eight disputes fit',
        repo: false,
      },
      {
        id: 'codex:glm:C1',
        critic: 'codex',
        target: 'glm',
        claim: 'no tests for the parser',
        why: '',
        repo: false,
      },
    ])
    expect(prose).toBe('Some opening prose.')
  })

  it('reads objections with no heading as aimed at the only peer', () => {
    const { objections } = parseCritique('codex', 'C1: wrong file—it moved', [claude])
    expect(objections).toMatchObject([{ target: 'claude', claim: 'wrong file', why: 'it moved' }])
  })

  it('keeps as prose what it cannot place: no target, an unknown one, repeats and past the cap', () => {
    const overCap = Array.from(
      { length: MAX_OBJECTIONS + 1 },
      (_, index) => `C${String(index + 1)}: claim ${String(index + 1)}`,
    )
    const text = [
      'C1: before any heading',
      'TARGET: kimi',
      'C1: aimed at nobody here',
      'TARGET: Claude',
      ...overCap,
      'C1: repeated',
      'not an objection',
      '',
    ].join('\n')

    const { objections, prose } = parseCritique('codex', text, [claude, glm])

    expect(objections.map(({ id }) => id)).toEqual(
      Array.from({ length: MAX_OBJECTIONS }, (_, index) => `codex:claude:C${String(index + 1)}`),
    )
    expect(prose.split('\n')).toEqual([
      'C1: before any heading',
      'TARGET: kimi',
      'C1: aimed at nobody here',
      `C${String(MAX_OBJECTIONS + 1)}: claim ${String(MAX_OBJECTIONS + 1)}`,
      'C1: repeated',
      'not an objection',
    ])
  })

  it('strips emphasis and reads an unknown tag as not about the repository', () => {
    const { objections } = parseCritique('codex', 'C1 [design]: **too broad**', [claude])
    expect(objections).toMatchObject([{ claim: 'too broad', repo: false }])
  })
})

describe('parseReply', () => {
  const ids = ['codex:claude:C1', 'codex:claude:C2']

  it('reads the replies and the tagged plan', () => {
    const text = `<replies>
codex:claude:C1: ACCEPT — moved it
**CODEX:CLAUDE:C2**: reject: the cap is fine
codex:claude:C9: accept — unknown id
codex:claude:C1: reject — a second answer
a note between replies
</replies>
<revised-plan>
# Plan
</revised-plan>`

    expect(parseReply('claude', text, ids, 'old')).toEqual({
      replies: [
        { id: 'codex:claude:C1', author: 'claude', decision: 'accept', reason: 'moved it' },
        { id: 'codex:claude:C2', author: 'claude', decision: 'reject', reason: 'the cap is fine' },
      ],
      plan: '# Plan',
      prose: 'a note between replies',
    })
  })

  it('reads ids between named agents, hyphens and all', () => {
    const peer = { name: 'gpt-mini', label: 'Codex (gpt-mini)' }
    const { objections } = parseCritique('sol-2', 'TARGET: Codex (gpt-mini)\nC1: no cache', [peer])
    expect(objections.map(({ id, target }) => [id, target])).toEqual([
      ['sol-2:gpt-mini:C1', 'gpt-mini'],
    ])
    const { replies } = parseReply(
      'gpt-mini',
      '<replies>\nsol-2:gpt-mini:C1: ACCEPT — added\n</replies>\n<revised-plan>\n# Plan\n</revised-plan>',
      ['sol-2:gpt-mini:C1'],
      'old',
    )
    expect(replies).toEqual([
      { id: 'sol-2:gpt-mini:C1', author: 'gpt-mini', decision: 'accept', reason: 'added' },
    ])
  })

  it('runs an unclosed plan tag to the end', () => {
    expect(parseReply('claude', '<revised-plan>\n# Plan\nstep', ids, 'old').plan).toBe(
      '# Plan\nstep',
    )
  })

  it('takes the plan after a Revised plan heading', () => {
    const text = 'codex:claude:C1: accept — ok\n\n## Revised plan\n\n# Plan'
    const reply = parseReply('claude', text, ids, 'old')
    expect(reply.plan).toBe('# Plan')
    expect(reply.replies).toHaveLength(1)
  })

  it('takes the text outside the replies, without reply lines, as the plan', () => {
    const tagged = parseReply(
      'claude',
      '<replies>\ncodex:claude:C1: accept\n</replies>\n# Plan',
      ids,
      'old',
    )
    expect(tagged.plan).toBe('# Plan')
    const untagged = parseReply('claude', 'codex:claude:C1: reject — no\n# Plan', ids, 'old')
    expect(untagged).toMatchObject({ plan: '# Plan', prose: '' })
  })

  it('keeps the previous plan when the answer holds none', () => {
    expect(parseReply('claude', '', ids, 'old')).toEqual({ replies: [], plan: 'old', prose: '' })
    expect(
      parseReply('claude', '<replies>codex:claude:C1: accept</replies>', ids, 'old').plan,
    ).toBe('old')
  })
})

describe('buildDisputes', () => {
  it('turns only rejected objections into disputes, merging the same claim on the same plan', () => {
    const objections = [
      objection({ id: 'codex:claude:C1', claim: 'Design is wrong', why: 'too big' }),
      objection({ id: 'codex:claude:C2', claim: 'accepted one' }),
      objection({ id: 'glm:claude:C1', critic: 'glm', claim: 'design is  wrong!', repo: true }),
      objection({ id: 'glm:claude:C2', critic: 'glm', claim: 'design is wrong', why: 'again' }),
      objection({ id: 'glm:codex:C1', critic: 'glm', target: 'codex', claim: 'design is wrong' }),
      objection({ id: 'glm:claude:C3', critic: 'glm', claim: 'unanswered' }),
    ]
    const replies: Reply[] = [
      reject('codex:claude:C1', 'it is fine'),
      { id: 'codex:claude:C2', author: 'claude', decision: 'accept', reason: '' },
      reject('glm:claude:C1', ''),
      reject('glm:claude:C2', 'still fine'),
      { ...reject('glm:codex:C1', 'fine too'), author: 'codex' },
    ]

    const { disputes, overflow } = buildDisputes(objections, replies)

    expect(overflow).toEqual([])
    expect(disputes).toEqual([
      {
        id: 'D1',
        target: 'claude',
        critics: ['codex', 'glm'],
        objections: ['codex:claude:C1', 'glm:claude:C1', 'glm:claude:C2'],
        claim: 'Design is wrong',
        reasons: ['too big', 'again'],
        rejections: ['it is fine', 'still fine'],
        repo: true,
      },
      {
        id: 'D2',
        target: 'codex',
        critics: ['glm'],
        objections: ['glm:codex:C1'],
        claim: 'design is wrong',
        reasons: [],
        rejections: ['fine too'],
        repo: false,
      },
    ])
  })

  it('ranks by critics, then repository claims, then order, and caps the list', () => {
    const objections = Array.from({ length: MAX_DISPUTES + 2 }, (_, index) =>
      objection({
        id: `codex:claude:C${String(index)}`,
        claim: `claim ${String(index)}`,
        repo: index === 3,
      }),
    )
    const { disputes, overflow } = buildDisputes(
      objections,
      objections.map(({ id }) => reject(id)),
    )
    expect(disputes.map(({ id, claim }) => `${id} ${claim}`)).toEqual([
      'D1 claim 3',
      ...[0, 1, 2, 4, 5, 6, 7].map((n, index) => `D${String(index + 2)} claim ${String(n)}`),
    ])
    expect(overflow.map(({ id }) => id)).toEqual(['D9', 'D10'])
    expect(buildDisputes(objections, [reject('codex:claude:C0')], 0).overflow).toHaveLength(1)
  })
})

describe('assignChecks', () => {
  const dispute = (id: string, target: string, critics: string[]): Dispute => ({
    id,
    target,
    critics,
    objections: [],
    claim: id,
    reasons: [],
    rejections: [],
    repo: true,
  })

  it('gives each claim to a checker who did not raise it, peers before the author', () => {
    const assigned = assignChecks(
      [
        dispute('D1', 'claude', ['codex']),
        dispute('D2', 'claude', ['codex', 'glm']),
        dispute('D3', 'glm', ['codex', 'claude']),
        dispute('D4', 'claude', ['codex']),
      ],
      ['codex', 'claude', 'glm'],
    )
    expect(
      Object.fromEntries(
        [...assigned].map(([checker, claims]) => [checker, claims.map(({ id }) => id)]),
      ),
    ).toEqual({
      // D3's critics are the other two, so only its author is left to check it.
      glm: ['D1', 'D3', 'D4'],
      claude: ['D2'],
    })
  })

  it('leaves out a claim nobody may check', () => {
    expect(
      assignChecks([dispute('D1', 'claude', ['codex', 'claude'])], ['codex', 'claude']).size,
    ).toBe(0)
  })
})

describe('parseChecks', () => {
  it('reads one answer per id, and marks a missing one unknown', () => {
    const text =
      'D1: CONFIRM — src/jev.ts:judge\n**d2**: refute\nD1: refute — second\nD9: confirm — unknown id\nnoise'
    expect(Object.fromEntries(parseChecks('glm', text, ['D1', 'D2', 'D3']))).toEqual({
      D1: { checker: 'glm', result: 'confirm', evidence: 'src/jev.ts:judge' },
      D2: { checker: 'glm', result: 'refute', evidence: '' },
      D3: { checker: 'glm', result: 'unknown', evidence: '' },
    })
  })
})
