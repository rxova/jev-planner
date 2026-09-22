/** Thrown before any agent call when the task is empty or a placeholder. */
export class TaskValidationError extends Error {
  override name = 'TaskValidationError'
}

export const MISSING_TASK_MESSAGE =
  'Missing coding task. Pass it as an argument, with --file, on stdin, or as task in jev-planner.json.'

/** Piped text and a configured task at once: the pipe is never silently ignored. */
export const STDIN_CONFLICT_MESSAGE =
  "The task is piped on stdin and set in the config. Pass the task as an argument or with --file to override the config's task."

/**
 * Whole-text placeholders, compared after normalization. Kept short and fixed:
 * a false rejection costs a user more than a wasted run, so widen it only after
 * a real incident.
 */
const PLACEHOLDERS = new Set([
  'describe the coding change you want to plan',
  'your task here',
  'todo',
  'tbd',
  '<coding task>',
])

/** Unfilled template slots: `<task>`, `{{task}}`, `[task]`, as the whole text. */
const TEMPLATE_SLOTS = [/^<[^>]*>$/, /^\{\{.*\}\}$/s, /^\[[^\]]*\]$/]

/** Lowercase, collapse whitespace, drop trailing punctuation: for comparison only. */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.!?,;:…]+$/, '')
}

function preview(text: string): string {
  const line = text.replace(/\s+/g, ' ')
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}

/** The trimmed task, or a `TaskValidationError` if nothing is left. */
export function requireNonEmptyTask(raw: string): string {
  const task = raw.trim()
  if (!task) throw new TaskValidationError(MISSING_TASK_MESSAGE)
  return task
}

/**
 * The trimmed task, or a `TaskValidationError` if it is empty or a near-certain
 * placeholder: a known template phrase, an unfilled `<…>`, `{{…}}` or `[…]`
 * slot, or text with no letters in it. Matches the whole text only, so a brief
 * that quotes a placeholder passes, and so does any short real task.
 */
export function validateTask(raw: string): string {
  const task = requireNonEmptyTask(raw)
  if (
    PLACEHOLDERS.has(normalize(task)) ||
    TEMPLATE_SLOTS.some((slot) => slot.test(task)) ||
    !/\p{L}/u.test(task)
  ) {
    throw new TaskValidationError(
      `The task looks like a placeholder: "${preview(task)}". ` +
        'Pass the change to plan as an argument, with --file, on stdin or in jev-planner.json, ' +
        'or use --allow-any-task to plan it anyway.',
    )
  }
  return task
}
