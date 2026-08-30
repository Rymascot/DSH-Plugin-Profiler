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
  readonly schemaVersion: 2
  readonly runId: string
  readonly entryId: string
  readonly moduleName?: string
  readonly origin: PluginOrigin
  readonly generation: number
  readonly firstSeenOffsetMs: number
  readonly lastSeenOffsetMs: number
  readonly lastState: LifecycleState
  readonly outcome: ActivationOutcome
  readonly failureStage?: 'pending' | 'loading' | 'unknown'
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
  readonly schemaVersion: 2
  readonly provenance: ProfileProvenance
  readonly collector: {
    readonly mode: 'host-runtime'
    readonly coverage: 'partial'
    readonly attachedAtMonotonicMs: number
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

