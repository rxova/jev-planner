import { defineConfig } from 'tsdown'
import { baseBuildConfig } from '@repo/config/tsdown.base'

// Node 20 rather than the preset's 22: jev-planner depends on this package,
// and its `engines` promises 20.19, so this one promises the same.
export default defineConfig(baseBuildConfig({ target: 'node20' }))
