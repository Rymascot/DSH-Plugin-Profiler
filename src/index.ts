import { createCordisLifecycleSource, type CordisContextLike } from './adapters/cordis-internal.js'
import { createProfileOriginIndex } from './adapters/profile-manifest.js'
import { monotonicClock, ProfilerCollector } from './core/collector.js'
import { ProfilerGateway } from './host/gateway.js'
import { PROFILER_SERVICE } from './typert-descriptor.js'

export type { CordisContextLike } from './adapters/cordis-internal.js'
export {
  CORDIS_FIBER_STATE,
  createCordisLifecycleSource,
  mapCordisFiberState,
} from './adapters/cordis-internal.js'
export {
  createProfileOriginIndex,
  profileDirFromBaseUrl,
  readProfileManifestFacts,
  type ManifestReader,
  type ProfileAnchorLike,
} from './adapters/profile-manifest.js'
export * from './core/index.js'
export { ProfilerGateway } from './host/gateway.js'
export { parseProfilerSnapshot, profilerSnapshotSchema } from './wire/schema.js'

export const name = 'plugin-profiler'

const collectors = new WeakMap<object, ProfilerCollector>()
const gateways = new WeakMap<object, ProfilerGateway>()

export function getProfilerCollector(ctx: object): ProfilerCollector | undefined {
  return collectors.get(ctx)
}

export function getProfilerGateway(ctx: object): ProfilerGateway | undefined {
  return gateways.get(ctx)
}

export function apply(ctx: CordisContextLike): void {
  if (typeof ctx.effect !== 'function') {
    throw new TypeError('DSH Plugin Profiler requires a Cordis context with ctx.effect().')
  }
  if (typeof ctx.provide !== 'function') {
    throw new TypeError('DSH Plugin Profiler requires a Cordis context with ctx.provide().')
  }

  ctx.effect(() => {
    // 归属只影响展示分层,读清单失败会降级成"未判定",不会影响采集。
    const origin = createProfileOriginIndex(ctx)
    const collector = new ProfilerCollector(
      createCordisLifecycleSource(ctx),
      monotonicClock,
      undefined,
      origin,
    )
    const stop = collector.start()
    const gateway = new ProfilerGateway(collector)
    let disposeGateway: (() => unknown) | undefined

    try {
      disposeGateway = ctx.provide(PROFILER_SERVICE, gateway)
      collectors.set(ctx, collector)
      gateways.set(ctx, gateway)
    } catch (error) {
      stop()
      throw error
    }

    return () => {
      disposeGateway?.()
      stop()
      gateways.delete(ctx)
      collectors.delete(ctx)
    }
  }, 'dsh-plugin-profiler: lifecycle collector and Remote gateway')
}
