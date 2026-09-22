import type { JudgeModel } from '@rxova/journey-judge'
import type { JudgeConfig, PanelEntry } from './config.js'
import { GraphJevJudge } from './graph-jev.js'
import type { JudgeSetup, Provider } from './provider.js'
import { PROVIDERS } from './providers.js'
import type { JevJudge } from './types.js'

type JudgingProvider = Provider & Required<Pick<Provider, 'judge'>>

const canJudge = (provider: Provider): provider is JudgingProvider => provider.judge !== undefined

/** The provider behind a panel entry, which must exist and be able to judge. */
function judging(entry: PanelEntry, providers: readonly Provider[]): JudgingProvider {
  const provider = providers.find(({ id }) => id === entry.provider)
  if (!provider) throw new Error(`judge.panel: unknown provider ${entry.provider}`)
  if (!canJudge(provider)) throw new Error(`judge.panel: ${provider.label} cannot judge`)
  return provider
}

/** The providers on the panel, once each, in the panel's order. */
export function panelProviders(
  panel: readonly PanelEntry[],
  providers: readonly Provider[] = PROVIDERS,
): Provider[] {
  return [...new Set(panel.map((entry) => judging(entry, providers)))]
}

/**
 * The graph judge's panel: one model per entry, named `<provider>` or
 * `<provider>/<model>`, answering through its provider's `judge`.
 */
export function judgePanel(
  panel: readonly PanelEntry[],
  setup: Omit<JudgeSetup, 'model'>,
  providers: readonly Provider[] = PROVIDERS,
): JudgeModel[] {
  // Every entry is checked before any is built.
  const found = panel.map((entry) => ({ entry, provider: judging(entry, providers) }))
  return found.map(({ entry, provider }) => ({
    id: entry.model === undefined ? entry.provider : `${entry.provider}/${entry.model}`,
    ...(entry.weight === undefined ? {} : { weight: entry.weight }),
    complete: provider.judge({
      ...setup,
      ...(entry.model === undefined ? {} : { model: entry.model }),
    }),
  }))
}

/**
 * TypeSafe's Jev, its SDK loaded on the first verdict, so a run with the graph
 * judge never loads it.
 */
function typeSafeJudge(): JevJudge {
  let loaded: Promise<JevJudge> | undefined
  return {
    judge: async (input) => {
      loaded ??= import('./jev.js').then(({ TypeSafeJevJudge }) => new TypeSafeJevJudge())
      return (await loaded).judge(input)
    },
  }
}

/** The run's judge, from the config's `judge`. `setup` is where the panel's models run. */
export function createJevJudge(
  config: JudgeConfig,
  setup: Omit<JudgeSetup, 'model'>,
  providers: readonly Provider[] = PROVIDERS,
): JevJudge {
  if (config.kind === 'typesafe') return typeSafeJudge()
  return new GraphJevJudge({
    panel: judgePanel(config.panel, setup, providers),
    ...(config.samples === undefined ? {} : { samples: config.samples }),
    ...(config.maxCalls === undefined ? {} : { maxCalls: config.maxCalls }),
    ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }),
    ...(config.claimChecks === undefined ? {} : { claimChecks: config.claimChecks }),
  })
}
