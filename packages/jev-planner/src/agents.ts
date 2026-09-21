import { runProcess } from './process.js'
import type { AgentRequest, PlanningAgent } from './types.js'

function requireOutput(agent: string, output: string): string {
  const result = output.trim()
  if (!result) throw new Error(`${agent} returned an empty response`)
  return result
}

export class CodexAgent implements PlanningAgent {
  readonly name = 'codex' as const

  constructor(private readonly model?: string) {}

  async generate(request: AgentRequest): Promise<string> {
    const args = [
      'exec',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
    ]
    if (this.model) args.push('--model', this.model)
    args.push('-')

    const { stdout } = await runProcess('codex', args, {
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
      omitEnv: ['TYPESAFE_API_KEY'],
    })
    return requireOutput('Codex', stdout)
  }
}

export class ClaudeAgent implements PlanningAgent {
  readonly name = 'claude' as const

  constructor(private readonly model?: string) {}

  async generate(request: AgentRequest): Promise<string> {
    const args = [
      '--print',
      '--permission-mode',
      'plan',
      '--permission-prompts',
      'none',
      '--no-session-persistence',
      '--output-format',
      'text',
      '--tools',
      'Read,Glob,Grep',
    ]
    if (this.model) args.push('--model', this.model)

    const { stdout } = await runProcess('claude', args, {
      cwd: request.cwd,
      input: request.prompt,
      timeoutMs: request.timeoutMs,
      omitEnv: ['TYPESAFE_API_KEY'],
    })
    return requireOutput('Claude', stdout)
  }
}
