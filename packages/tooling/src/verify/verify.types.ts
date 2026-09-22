/** Runs one step. Injected so the sequencing can be tested without running it. */
export type Runner = (command: string) => void
