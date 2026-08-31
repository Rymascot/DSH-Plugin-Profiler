import type { Dispose, LifecycleSource } from '../core/contracts.js'
import type {
  DependencyLink,
  LifecycleSignal,
  LifecycleState,
  LoaderEntryView,
} from '../core/types.js'

export const CORDIS_FIBER_STATE = {
  PENDING: 0,
  LOADING: 1,
  ACTIVE: 2,
  FAILED: 3,
  DISPOSED: 4,
  UNLOADING: 5,
} as const

interface CordisEntryLike {
  readonly id?: unknown
  readonly options?: {
    readonly name?: unknown
    /** Loader 用它标记分组容器。 */
    readonly group?: unknown
    /** 条目自己声明的依赖;数组或 required/optional 结构。 */
    readonly inject?: unknown
  }
  /** 这个条目当前的 Fiber;条目没跑起来时为 undefined。 */
  readonly fiber?: CordisFiberLike
}

/** `ctx.loader` 的最小可用面:遍历本树及嵌套子树的全部条目。 */
interface CordisLoaderLike {
  entries(): Iterable<CordisEntryLike>
}

interface CordisFiberLike {
  readonly state?: unknown
  readonly entry?: CordisEntryLike
  /** 插件被加载时所在的 Context;它的 `fiber` 就是父条目的 Fiber。 */
  readonly parent?: { readonly fiber?: CordisFiberLike }
  /** Cordis 解析后的依赖表:服务名 -> intercept 配置。 */
  readonly inject?: unknown
  /** 加载期间所需服务实现的快照;卸载后被清空。 */
  readonly store?: unknown
}

export interface CordisContextLike {
  /** Loader 锚定在 Profile 目录上的 file URL;归属判定用它定位 Profile 清单。 */
  readonly baseUrl?: unknown
  /** Loader 服务。没有它就只能靠事件流,而事件流看不见先启动完的插件。 */
  readonly loader?: unknown
  on(
    event: 'internal/status',
    listener: (fiber: CordisFiberLike, previousState: unknown) => void,
  ): (() => unknown)
  effect(execute: () => Dispose, label?: string): unknown
  provide(name: string, value: object): (() => unknown)
}

export function mapCordisFiberState(value: unknown): LifecycleState {
  if (value === CORDIS_FIBER_STATE.PENDING) return 'pending'
  if (value === CORDIS_FIBER_STATE.LOADING) return 'loading'
  if (value === CORDIS_FIBER_STATE.ACTIVE) return 'active'
  if (value === CORDIS_FIBER_STATE.FAILED) return 'failed'
  if (value === CORDIS_FIBER_STATE.DISPOSED) return 'disposed'
  if (value === CORDIS_FIBER_STATE.UNLOADING) return 'unloading'
  return 'unknown'
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return normalized === '' ? undefined : normalized
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function stringItems(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item: unknown) => {
    const name = nonEmptyString(item)
    return name === undefined ? [] : [name]
  })
}

/**
 * 这个条目注入的服务名。
 *
 * `fiber.inject` 是 Cordis 解析后的依赖表,Loader 可能往里追加过条目,所以它比条目
 * 自己声明的那份更接近运行时真相;读不到时才退回声明值。
 */
export function injectedServiceNames(fiber: CordisFiberLike): string[] {
  if (isRecord(fiber.inject)) return Object.keys(fiber.inject).filter(name => name.trim() !== '')

  const declared = fiber.entry?.options?.inject
  if (Array.isArray(declared)) return stringItems(declared)
  if (isRecord(declared)) {
    return [...stringItems(declared['required']), ...stringItems(declared['optional'])]
  }
  return []
}

/** 从服务实现快照里取出提供方所属的 Loader 条目。 */
function providerEntryIdOf(impl: unknown): string | undefined {
  if (!isRecord(impl)) return undefined
  const providerFiber = impl['fiber']
  if (!isRecord(providerFiber)) return undefined
  const entry = providerFiber['entry']
  if (!isRecord(entry)) return undefined
  return nonEmptyString(entry['id'])
}

/**
 * 把注入的服务映射到提供它的条目。
 *
 * `fiber.store` 在进入 loading 之前一刻被写好、在卸载时被清空,所以这里读到的
 * 提供方就是当时真正满足依赖的那批 Fiber。
 */
export function readDependencies(fiber: CordisFiberLike): DependencyLink[] | undefined {
  const services = injectedServiceNames(fiber)
  if (services.length === 0) return undefined

  const store = isRecord(fiber.store) ? fiber.store : undefined
  return services.map(service => {
    const providerEntryId = providerEntryIdOf(store?.[service])
    return providerEntryId === undefined ? { service } : { service, providerEntryId }
  })
}

/**
 * 读一遍 Loader 名单。
 *
 * 这是知道"有谁在跑"的唯一办法:`internal/status` 只在状态变化时才发,先于 Profiler
 * 启动完的插件早已停下不动,事件流里永远不会出现。
 *
 * 只收有活着 Fiber 的条目。名单上有、但没跑起来的(比如被禁用的)不属于这个工具的
 * 范围——报告没运行过的东西会把它变成"已安装插件清单"。
 */
export function readLoaderEntries(ctx: CordisContextLike): LoaderEntryView[] {
  const loader = ctx.loader
  if (!isRecord(loader) || typeof loader['entries'] !== 'function') return []

  const views: LoaderEntryView[] = []
  try {
    for (const entry of (loader as unknown as CordisLoaderLike).entries()) {
      const entryId = nonEmptyString(entry.id)
      const fiber = entry.fiber
      if (entryId === undefined || fiber === undefined || fiber === null) continue

      const moduleName = nonEmptyString(entry.options?.name)
      const parentEntryId = nonEmptyString(fiber.parent?.fiber?.entry?.id)
      views.push({
        entryId,
        isGroup: entry.options?.group === true,
        state: mapCordisFiberState(fiber.state),
        dependencies: readDependencies(fiber) ?? [],
        ...(moduleName === undefined ? {} : { moduleName }),
        ...(parentEntryId === undefined ? {} : { parentEntryId }),
      })
    }
  } catch {
    // 版本敏感面。读不到名单就退回"只有事件流"的行为,不能让 Host 挂掉。
  }
  return views
}

export function createCordisLifecycleSource(ctx: CordisContextLike): LifecycleSource {
  if (typeof ctx.on !== 'function') {
    throw new TypeError('DSH Plugin Profiler requires a Cordis context with ctx.on().')
  }

  return {
    subscribe(listener): Dispose {
      const dispose = ctx.on('internal/status', (fiber, previousState) => {
        if (typeof fiber !== 'object' || fiber === null) return

        try {
          const entryId = nonEmptyString(fiber.entry?.id)
          const moduleName = nonEmptyString(fiber.entry?.options?.name)
          const parentEntryId = nonEmptyString(fiber.parent?.fiber?.entry?.id)
          const dependencies = readDependencies(fiber)
          const signal: LifecycleSignal = {
            fiberToken: fiber,
            previous: mapCordisFiberState(previousState),
            current: mapCordisFiberState(fiber.state),
            ...(entryId === undefined ? {} : { entryId }),
            ...(moduleName === undefined ? {} : { moduleName }),
            ...(fiber.entry?.options?.group === true ? { isGroup: true } : {}),
            ...(parentEntryId === undefined ? {} : { parentEntryId }),
            ...(dependencies === undefined ? {} : { dependencies }),
          }
          listener(signal)
        } catch {
          // This adapter touches version-sensitive internal objects. A malformed
          // event must not take down the DSH Host process.
        }
      })

      return () => {
        dispose()
      }
    },
  }
}
