/** One line of `codex exec --json`. */
export interface CodexEvent {
  type?: string
  thread_id?: string
  item?: { type?: string; text?: string; command?: string; exit_code?: number | null }
  error?: { message?: string }
  message?: string
}

/** One line of `claude --output-format stream-json`. */
export interface ClaudeEvent {
  type?: string
  message?: {
    content?: { type?: string; text?: string; name?: string; input?: Record<string, unknown> }[]
  }
  result?: string
  is_error?: boolean
}

export interface Overrides {
  model?: string
  effort?: string
}
