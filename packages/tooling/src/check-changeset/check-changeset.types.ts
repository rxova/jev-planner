/** How the range is read. Injected so the rule can be tested without a repository. */
export type Differ = (base: string, head: string) => string[]

export interface Verdict {
  exitCode: 0 | 1
  message: string
}
