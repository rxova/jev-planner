import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgents, main } from './cli.js'
import { Planner } from '../orchestrator/orchestrator.js'
import { runProcess } from '../process/process.js'
import type * as processModule from '../process/process.js'
import type { CliDeps } from './cli.types.js'
import type { PlanJudge, Verdict } from '../questions/questions.types.js'

vi.mock('../process/process.js', async (importOriginal) => ({
  ...(await importOriginal<typeof processModule>()),
  runProcess: vi.fn(),
}))

const run = vi.mocked(runProcess)

/** Each `codex` call: which instance made it (by its model), its argv, and the thread it named or resumed. */
interface Call {
  model: string
  args: readonly string[]
  thread: string
}

/**
 * A scripted `codex exec --json`: it knows which agent it is from `--model`,
 * and which stage it answers from the prompt. A critique aims its objections
 * at the other instance by label, so a TARGET line must resolve by label.
 */
function scriptCodex(calls: Call[]) {
  const threads = new Map<string, number>()
  run.mockImplementation((_command, args, options) => {
    const model = args[args.indexOf('--model') + 1] ?? ''
    const input = options.input ?? ''
    const resumed = args.includes('resume')
    const thread = resumed
      ? (args.at(-2) ?? '')
      : `thread-${model}-${String((threads.get(model) ?? 0) + 1)}`
    if (!resumed) threads.set(model, (threads.get(model) ?? 0) + 1)
    calls.push({ model, args, thread })
    const peer = model === 'a' ? 'Codex (terra)' : 'Codex (sol)'
    let answer = `# Plan by ${model}\n\nStep one.`
    if (input.includes('Critique the peer plans')) {
      answer = `TARGET: ${peer}\nC1: misses the cache — it matters\nC2: no tests — it matters`
    } else if (input.includes('<replies>')) {
      const ids = [...input.matchAll(/^(\S+:\S+:C\d+) \(/gm)].map(([, id]) => id)
      answer = `<replies>\n${ids.map((id) => `${String(id)}: ACCEPT — done`).join('\n')}\n</replies>\n<revised-plan>\n# Revised by ${model}\n</revised-plan>`
    }
    if (!args.includes('--ephemeral')) {
      options.onLine?.(JSON.stringify({ type: 'thread.started', thread_id: thread }), 'stdout')
    }
    options.onLine?.(
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: answer } }),
      'stdout',
    )
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 })
  })
}

const verdict: Verdict = {
  strongerPlan: 'sol',
  strongerPlanConfidence: 0.7,
  finalizer: 'terra',
  finalizerConfidence: 0.6,
  completeness: 3,
  completenessConfidence: 0.9,
  feasibility: 3,
  feasibilityConfidence: 0.9,
  riskCoverage: 2,
  riskCoverageConfidence: 0.8,
  needsAnotherPassProbability: 0.1,
  standsAloneProbability: 0.2,
  model: 'jev-test',
}

let dir: string

beforeEach(async () => {
  run.mockReset()
  dir = await mkdtemp(join(tmpdir(), 'jev-planner-single-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function plan(argv: string[]) {
  const calls: Call[] = []
  scriptCodex(calls)
  const judged: Parameters<PlanJudge['judge']>[0][] = []
  const jev: PlanJudge = {
    name: 'Jev',
    judge: (input) => {
      judged.push(input)
      return Promise.resolve(verdict)
    },
  }
  let out = ''
  let err = ''
  const deps: CliDeps = {
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    env: { TYPESAFE_API_KEY: 'key' },
    cwd: () => dir,
    readStdin: () => Promise.resolve(undefined),
    createPlanner: (setup) => new Planner(createAgents(setup, {}, []), jev),
    doctor: () => Promise.resolve([]),
    now: () => new Date('2026-09-22T10:00:00Z'),
    program: {
      name: 'jev-planner',
      version: '0.0.0',
      summary: 'plans',
      judge: 'Jev',
      judgeModelDefault: 'jev-latest',
      judgeEnv: [{ variable: 'TYPESAFE_API_KEY', check: 'TypeSafe key', missing: 'no key' }],
    },
  }
  const code = await main(
    [
      '--no-config',
      '--agents',
      'codex:sol,codex:terra',
      '--model',
      'sol=a',
      '--model',
      'terra=b',
      '--mode',
      'ultra',
      '--review-mode',
      'debate',
      '--review-rounds',
      '1',
      '--rounds-dir',
      'rounds',
      '--json',
      ...argv,
      'Add caching to the planner',
    ],
    deps,
  )
  return { code, calls, judged, err, json: JSON.parse(out || '{}') as Record<string, unknown> }
}

describe('two agents from one provider, end to end', () => {
  it('runs each under its own name, model, session and files', async () => {
    const { code, calls, judged, err, json } = await plan([])
    expect(err).not.toContain('jev-planner: ')
    expect(code).toBe(0)

    // Each call carries its own agent's model, and only those two models run.
    expect(new Set(calls.map(({ model }) => model))).toEqual(new Set(['a', 'b']))
    // Two sessions, one per agent, and every later call resumes its own.
    const started = calls.filter(({ args }) => !args.includes('resume'))
    expect(started.map(({ thread }) => thread).sort()).toEqual(['thread-a-1', 'thread-b-1'])
    const resumed = calls.filter(({ args }) => args.includes('resume'))
    expect(new Set(resumed.map(({ model }) => model))).toEqual(new Set(['a', 'b']))
    for (const { model, thread } of resumed) expect(thread).toBe(`thread-${model}-1`)

    // Jev sees the two plans by name, told apart by label.
    expect(judged[0]?.plans.map(({ agent, label }) => [agent, label])).toEqual([
      ['sol', 'Codex (sol)'],
      ['terra', 'Codex (terra)'],
    ])
    // A TARGET line by label resolved to the name, and every objection was answered.
    const debate = json.debate as { objections: { id: string }[] }
    expect(debate.objections.map(({ id }) => id).sort()).toEqual([
      'sol:terra:C1',
      'sol:terra:C2',
      'terra:sol:C1',
      'terra:sol:C2',
    ])
    expect(['sol', 'terra']).toContain(json.finalizer)

    const round1 = join(dir, 'rounds', 'round1')
    expect((await readdir(round1)).filter((file) => file.endsWith('.md')).sort()).toEqual([
      'sol.md',
      'terra.md',
    ])
    const timings = JSON.parse(await readFile(join(round1, 'timings.json'), 'utf8')) as {
      agents: Record<string, number>
    }
    expect(Object.keys(timings.agents).sort()).toEqual(['sol', 'terra'])
  })

  it('keeps no session with --no-resume', async () => {
    const { code, calls } = await plan(['--no-resume'])
    expect(code).toBe(0)
    expect(calls.length).toBeGreaterThan(2)
    for (const { args } of calls) {
      expect(args).toContain('--ephemeral')
      expect(args).not.toContain('resume')
    }
  })
})
