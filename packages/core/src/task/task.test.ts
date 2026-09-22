import { describe, expect, it } from 'vitest'
import {
  MISSING_TASK_MESSAGE,
  requireNonEmptyTask,
  TaskValidationError,
  validateTask,
} from './task.js'

describe('requireNonEmptyTask', () => {
  it('returns the trimmed task', () => {
    expect(requireNonEmptyTask('  Add caching \n')).toBe('Add caching')
  })

  it('rejects empty input with the original message', () => {
    for (const raw of ['', '   ', '\n\t']) {
      expect(() => requireNonEmptyTask(raw)).toThrow(new TaskValidationError(MISSING_TASK_MESSAGE))
    }
    expect(MISSING_TASK_MESSAGE).toBe(
      'Missing coding task. Pass it as an argument, with --file, on stdin, or as task in the config file.',
    )
  })

  it('accepts a placeholder', () => {
    expect(requireNonEmptyTask('TODO')).toBe('TODO')
  })
})

describe('validateTask', () => {
  const rejects = (raw: string) => {
    expect(() => validateTask(raw)).toThrow(TaskValidationError)
  }

  it('rejects the template phrase and its case, spacing and punctuation variants', () => {
    rejects('Describe the coding change you want to plan')
    rejects('  describe   THE coding change\nyou want to plan.  ')
    rejects('Describe the coding change you want to plan…')
    rejects('Describe the coding change you want to plan?!')
  })

  it('strips a long run of trailing punctuation', () => {
    rejects(`Describe the coding change you want to plan${'!'.repeat(50_000)}`)
    expect(validateTask(`Add a flag${'!'.repeat(50_000)}x`)).toMatch(/^Add a flag!/)
  })

  it('rejects the other known placeholders', () => {
    for (const raw of ['your task here', 'TODO', 'tbd.', '<coding task>']) rejects(raw)
  })

  it('rejects unfilled template slots', () => {
    for (const raw of ['<task>', '{{task}}', '{{\n  task\n}}', '[task]']) rejects(raw)
  })

  it('rejects text with no letters', () => {
    for (const raw of ['123', '...', '#1 -> 2']) rejects(raw)
  })

  it('rejects empty input with the original message', () => {
    expect(() => validateTask('   ')).toThrow(MISSING_TASK_MESSAGE)
  })

  it('accepts short real tasks, trimmed', () => {
    expect(validateTask(' Add caching ')).toBe('Add caching')
    expect(validateTask('task')).toBe('task')
    expect(validateTask('todo list pagination')).toBe('todo list pagination')
  })

  it('accepts a non-English task', () => {
    expect(validateTask('Añadir caché a la API')).toBe('Añadir caché a la API')
    expect(validateTask('キャッシュを追加する')).toBe('キャッシュを追加する')
  })

  it('accepts a brief that quotes a placeholder', () => {
    const brief =
      'The form still shows "Describe the coding change you want to plan".\n\nReplace it with real copy.'
    expect(validateTask(brief)).toBe(brief)
    expect(validateTask('Render <task> slots in the template')).toBe(
      'Render <task> slots in the template',
    )
  })

  it('names the placeholder and the override in its message', () => {
    expect(() => validateTask('TODO')).toThrow(
      'The task looks like a placeholder: "TODO". Pass the change to plan as an argument, ' +
        'with --file, on stdin or in the config file, or use --allow-any-task to plan it anyway.',
    )
  })

  it('shortens a long placeholder in its message', () => {
    const slot = `{{ ${'x'.repeat(100)} }}`
    expect(() => validateTask(slot)).toThrow(`"{{ ${'x'.repeat(54)}..."`)
  })

  it('names its errors', () => {
    expect(new TaskValidationError('m').name).toBe('TaskValidationError')
  })
})
