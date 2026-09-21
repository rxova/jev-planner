import { afterEach, describe, expect, it, vi } from 'vitest'
import { STEPS, shell, verify } from '../verify.js'

describe('STEPS', () => {
  it('covers every check CI runs, cheapest first', () => {
    expect(STEPS.map(([name]) => name)).toEqual([
      'dependency versions',
      'unused files, exports and dependencies',
      'dependency dedupe',
      'format',
      'lint',
      'llms.txt',
      'typecheck',
      'unit tests',
      'build',
      'package exports',
    ])
  })

  it('leaves audit to CI, where a fresh CVE cannot block an unrelated push', () => {
    expect(STEPS.some(([, command]) => command.includes('audit'))).toBe(false)
  })

  // docs.yml builds the site for jev-planner.com, browser-tests that dist and
  // deploys it. Building it again here would put an Astro build in front of
  // every push to re-prove what that job proves on the output that ships.
  it('leaves the docs site out of the build step', () => {
    const build = STEPS.find(([name]) => name === 'build')?.[1] ?? ''

    expect(build).toContain("--filter='!@repo/docs'")
  })
})

describe('verify', () => {
  const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  afterEach(() => {
    out.mockClear()
    err.mockClear()
  })

  it('runs every step in order and passes', () => {
    const ran: string[] = []
    const code = verify(
      [
        ['first', 'echo one'],
        ['second', 'echo two'],
      ],
      { run: (command) => void ran.push(command) },
    )

    expect(code).toBe(0)
    expect(ran).toEqual(['echo one', 'echo two'])
    expect(out).toHaveBeenCalledWith('\nverify: all checks passed\n')
  })

  it('stops at the first failure and names it', () => {
    const ran: string[] = []
    const code = verify(
      [
        ['first', 'echo one'],
        ['second', 'boom'],
        ['third', 'echo three'],
      ],
      {
        run: (command) => {
          ran.push(command)
          if (command === 'boom') throw new Error('exit 1')
        },
      },
    )

    expect(code).toBe(1)
    expect(ran).toEqual(['echo one', 'boom'])
    expect(err).toHaveBeenCalledWith('\nverify: second failed\n')
    expect(out).not.toHaveBeenCalledWith('\nverify: all checks passed\n')
  })

  it('announces each step before running it', () => {
    verify([['lint', 'echo lint']], { run: () => {} })
    expect(out).toHaveBeenCalledWith('\nverify: lint\n')
  })

  it('passes trivially on an empty list', () => {
    expect(verify([], { run: () => {} })).toBe(0)
  })
})

describe('shell', () => {
  it('runs a command', () => {
    expect(() => {
      shell(`"${process.execPath}" -e "0"`)
    }).not.toThrow()
  })

  it('throws when the command fails, which is what verify catches', () => {
    expect(() => {
      shell(`"${process.execPath}" -e "process.exit(3)"`)
    }).toThrow()
  })
})
