import type { PlannerProgram } from '@rxova/planner-core'
import packageJson from '../package.json' with { type: 'json' }

/** jev-planner, as the shared CLI in `@rxova/planner-core` runs it: judged by TypeSafe Jev. */
export const JEV_PLANNER: PlannerProgram = {
  name: 'jev-planner',
  version: packageJson.version,
  summary: 'collaborative coding plans from two or more agents, judged by Jev',
  judge: 'Jev',
  judgeModelDefault: "SDK's jev-latest",
  judgeEnv: [
    {
      variable: 'TYPESAFE_API_KEY',
      check: 'TypeSafe key',
      missing:
        'TYPESAFE_API_KEY is not set. Create a key at https://console.typesafe.ai/keys and export it first.',
    },
  ],
}
