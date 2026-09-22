export interface Failure {
  where: string
  reason: string
}

export interface PublishedPackage {
  dir: string
  name: string
  files: string[]
}

export interface Manifest {
  name: string
  private?: boolean
  files?: string[]
}
