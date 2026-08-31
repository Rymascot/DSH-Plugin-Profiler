export type LifecycleState =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'disposed'
  | 'unloading'
  | 'unknown'

export interface LifecycleSignal {
  readonly fiberToken: object
  readonly entryId?: string
  readonly moduleName?: string
  readonly previous: LifecycleState
  readonly current: LifecycleState
  /** Loader 把这个条目标成了分组容器,它的激活跨度包含全部子条目。 */
  readonly isGroup?: boolean
  /** 父条目的 Loader id;根条目没有父条目。 */
  readonly parentEntryId?: string
  /** 该条目注入的服务,以及当时提供这些服务的条目。 */
  readonly dependencies?: readonly DependencyLink[]
}

/** 一条依赖边:注入的服务名,以及提供它的 Loader 条目。 */
export interface DependencyLink {
  readonly service: string
  readonly providerEntryId?: string
}

/**
 * 直接从 Loader 名单上读到的一个条目。
 *
 * `internal/status` 只在状态**变化**时才发。Profiler 是 Profile 里靠后加载的一层,
 * 等它开始监听,先启动完的插件早已停在 active 上不动,再也不会发事件——光靠事件流
 * 根本不知道它们存在。读一遍 Loader 名单是唯一能知道"有谁"的办法。
 *
 * 名单只给得出"有谁、现在什么状态",给不出耗时。两者必须分开表达,不能把没测到的
 * 说成测到了。
 */
export interface LoaderEntryView {
  readonly entryId: string
  readonly moduleName?: string
  readonly isGroup: boolean
  readonly parentEntryId?: string
  readonly state: LifecycleState
  readonly dependencies: readonly DependencyLink[]
}

/**
 * 这条记录的来源。
 *
 * `lifecycle` 是真看着它跑完一轮激活,有计时。`enumerated` 只是在名单上见过它,
 * 说明它确实存在、现在是什么状态,但一个时间数字都没有。
 */
export type SampleObservation = 'lifecycle' | 'enumerated'

/**
 * 解除阻塞的那条依赖:最后一个就绪的提供方。
 *
 * `skewMs` 是提供方就绪与本条目离开 pending 之间的间隔。归因正确时两者应当几乎
 * 重合,间隔越大说明真正的阻塞源不在已观测到的依赖里,界面据此弱化展示。
 */
export interface BlockingAttribution {
  readonly service: string
  readonly entryId: string
  readonly providerReadyOffsetMs: number
  readonly skewMs: number
}

/**
 * 扣掉子条目之后的自身耗时。
 *
 * `exact` 表示所有子条目都有完整区间;`upper-bound` 表示有子条目缺少计时,扣不干净,
 * 真实自身耗时只会更小;`unobserved` 表示这次激活本身就没测到。
 */
export type SelfTimeBasis = 'exact' | 'upper-bound' | 'unobserved'

export interface SelfTime {
  readonly durationMs: number | null
  readonly basis: SelfTimeBasis
  readonly childEntryCount: number
}

export type SegmentCompleteness =
  | 'complete'
  | 'left-censored'
  | 'right-censored'
  | 'unobserved'

export interface SegmentTiming {
  readonly startOffsetMs: number | null
  readonly endOffsetMs: number | null
  readonly durationMs: number | null
  readonly completeness: SegmentCompleteness
}

/** 插件条目的归属:DSH 自带、用户安装,或无法判定。 */
export type PluginOrigin = 'builtin' | 'user' | 'unknown'

/** Profile `dsh.profile.bundles` 中的一层及其归属。 */
export interface BundleOrigin {
  readonly packageName: string
  readonly origin: 'builtin' | 'user'
}

/** 归属判定的来源描述;读不到 Profile 清单时 `resolved` 为 false。 */
export interface ProvenanceSource {
  readonly resolved: boolean
  readonly reason?: string
  readonly profileName?: string
  readonly bundles: readonly BundleOrigin[]
}

/** 快照级归属信息。`counts` 按 entryId 去重,重载不会把同一个插件数两次。 */
export interface ProfileProvenance extends ProvenanceSource {
  readonly counts: Readonly<Record<PluginOrigin, number>>
}

export type ActivationOutcome =
  | 'active'
  | 'failed'
  | 'in-progress'
  | 'disposed-before-terminal'

export interface ActivationSample {
  readonly schemaVersion: 4
  readonly runId: string
  readonly entryId: string
  readonly moduleName?: string
  readonly origin: PluginOrigin
  readonly observation: SampleObservation
  /** 第几次激活。`0` 表示一次都没观测到,只是在 Loader 名单上见过它。 */
  readonly generation: number
  /** 分组容器,不是插件本身;它的激活跨度包含子条目,排名时应当排除。 */
  readonly isGroup: boolean
  readonly parentEntryId?: string
  readonly firstSeenOffsetMs: number
  readonly lastSeenOffsetMs: number
  readonly lastState: LifecycleState
  readonly outcome: ActivationOutcome
  readonly failureStage?: 'pending' | 'loading' | 'unknown'
  readonly dependencies: readonly DependencyLink[]
  readonly blockedBy?: BlockingAttribution
  readonly selfTime: SelfTime
  readonly segments: {
    readonly dependencyWait: SegmentTiming
    readonly activation: SegmentTiming
  }
  readonly coverage: {
    readonly overall: 'partial'
    readonly collectorAttachedAfterBootStarted: true
    readonly moduleImportObserved: false
    readonly loaderBackedEntryOnly: true
  }
}

export type DiagnosticCode =
  | 'clock-regression'
  | 'duplicate-transition'
  | 'invalid-clock'
  | 'missing-entry-id'
  | 'reporter-error'
  | 'transition-gap'
  | 'unknown-state'

export interface ProfilerDiagnostic {
  readonly code: DiagnosticCode
  readonly offsetMs: number
  readonly message: string
  readonly entryId?: string
}

export interface ProfilerSnapshot {
  readonly schemaVersion: 4
  readonly provenance: ProfileProvenance
  readonly collector: {
    readonly mode: 'host-runtime'
    readonly coverage: 'partial'
    readonly attachedAtMonotonicMs: number
    /** 从 Profiler 挂载到读取这份快照之间的时长,即本次观测窗口。 */
    readonly observedUntilOffsetMs: number
    readonly target: {
      readonly dshVersion: string
      readonly dshCommit: string
    }
    readonly excluded: readonly [
      'events-before-profiler-attach',
      'module-resolution-and-import',
      'fibers-without-loader-entry',
      'whole-profile-cold-start',
      'critical-path',
    ]
  }
  readonly samples: readonly ActivationSample[]
  readonly diagnostics: {
    readonly total: number
    readonly byCode: Readonly<Record<DiagnosticCode, number>>
    readonly entries: readonly ProfilerDiagnostic[]
  }
}

export const TARGET_DSH = {
  version: '0.1.1-rc.2',
  commit: 'b150a551b8',
} as const

export const PARTIAL_COVERAGE = {
  overall: 'partial',
  collectorAttachedAfterBootStarted: true,
  moduleImportObserved: false,
  loaderBackedEntryOnly: true,
} as const

export const EXCLUDED_MEASUREMENTS = [
  'events-before-profiler-attach',
  'module-resolution-and-import',
  'fibers-without-loader-entry',
  'whole-profile-cold-start',
  'critical-path',
] as const

