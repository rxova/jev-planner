import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

// A write error on the child's stdin cannot be provoked deterministically with
// a real process, so this file swaps `spawn` for a controllable fake.
class FakeChild extends EventEmitter {
  readonly stdout = new EventEmitter()
  readonly stderr = new EventEmitter()
  readonly stdin = Object.assign(new EventEmitter(), { end: vi.fn() })
  readonly kill = vi.fn()
}

const children: FakeChild[] = []

vi.mock('node:child_process', () => ({
  spawn: () => {
    const child = new FakeChild()
    children.push(child)
    return child
  },
}))

const { runProcess } = await import('../process.js')

afterEach(() => {
  children.length = 0
})

function stdinError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

describe('runProcess stdin errors', () => {
  it('ignores EPIPE from a child that stops reading early', async () => {
    const pending = runProcess('agent', [], { cwd: '/', input: 'task' })
    const child = children[0]!
    child.stdin.emit('error', stdinError('EPIPE'))
    child.stdout.emit('data', Buffer.from('ok'))
    child.emit('close', 0)
    await expect(pending).resolves.toEqual({ stdout: 'ok', stderr: '', exitCode: 0 })
    expect(child.stdin.end).toHaveBeenCalledWith('task')
  })

  it('rejects on any other stdin error', async () => {
    const pending = runProcess('agent', [], { cwd: '/' })
    children[0]!.stdin.emit('error', stdinError('EACCES'))
    await expect(pending).rejects.toThrow('EACCES')
  })
})
