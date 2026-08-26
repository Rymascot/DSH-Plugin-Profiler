import { createCordisLifecycleSource, type CordisContextLike } from './adapters/cordis-internal.js'
import { ProfilerCollector } from './core/collector.js'

export type { CordisContextLike } from './adapters/cordis-internal.js'
export {
  CORDIS_FIBER_STATE,
  createCordisLifecycleSource,
  mapCordisFiberState,
} from './adapters/cordis-internal.js'
export * from './core/index.js'

export const name = 'plugin-profiler'

const collectors = new WeakMap<object, ProfilerCollector>()

export function getProfilerCollector(ctx: object): ProfilerCollector | undefined {
  return collectors.get(ctx)
}

export function apply(ctx: CordisContextLike): void {
  if (typeof ctx.effect !== 'function') {
    throw new TypeError('DSH Plugin Profiler requires a Cordis context with ctx.effect().')
  }

  const collector = new ProfilerCollector(createCordisLifecycleSource(ctx))
  const stop = collector.start()
  collectors.set(ctx, collector)

  try {
    ctx.effect(() => () => {
      stop()
      collectors.delete(ctx)
    }, 'dsh-plugin-profiler: lifecycle collector')
  } catch (error) {
    stop()
    collectors.delete(ctx)
    throw error
  }
}
