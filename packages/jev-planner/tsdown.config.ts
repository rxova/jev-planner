import { defineConfig } from 'tsdown'
import { baseBuildConfig } from '@repo/config/tsdown.base'

// Node 20 rather than the preset's 22: this package is published, and its
// `engines` promises 20.19. `bin.ts` is the executable; `index.ts` is the
// library, for callers that drive the planner with their own agents.
export default defineConfig(
  baseBuildConfig({ target: 'node20', entry: ['src/index.ts', 'src/bin.ts'] }),
)
