export type Shell = (command: string, args: string[], cwd: string) => string

export interface Workspace {
  make: () => string
  list: (dir: string) => string[]
  read: (file: string) => string
  write: (file: string, contents: string) => void
  remove: (dir: string) => void
}

export interface Manifest {
  name: string
  version: string
  files?: string[]
  dependencies?: Record<string, string>
}
