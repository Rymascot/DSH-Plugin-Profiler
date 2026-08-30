import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type {
  ActivationSample,
  PluginOrigin,
  ProfilerSnapshot,
  SegmentCompleteness,
} from '../core/types.js'
import type { ProfilerLocaleKey } from './locales.js'
import type { ProfilerSettingsTabProps } from './contracts.js'

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly message: string }
  | { readonly status: 'ready'; readonly snapshot: ProfilerSnapshot }

const OUTCOME_KEYS = {
  active: 'active',
  failed: 'failed',
  'in-progress': 'inProgress',
  'disposed-before-terminal': 'disposedBeforeTerminal',
} satisfies Record<ActivationSample['outcome'], ProfilerLocaleKey>

const ORIGIN_KEYS = {
  builtin: 'originBuiltin',
  user: 'originUser',
  unknown: 'originUnknown',
} satisfies Record<PluginOrigin, ProfilerLocaleKey>

const SELF_TIME_KEYS = {
  exact: 'selfExact',
  'upper-bound': 'selfUpperBound',
  unobserved: 'unobserved',
} satisfies Record<ActivationSample['selfTime']['basis'], ProfilerLocaleKey>

/** 归属筛选项。`all` 是默认值:先看"谁最慢",再决定要不要缩到自己的插件。 */
export type OriginFilter = PluginOrigin | 'all'

const ORIGIN_FILTERS: readonly OriginFilter[] = ['all', 'user', 'builtin', 'unknown']

const COMPLETENESS_KEYS = {
  complete: 'complete',
  'left-censored': 'leftCensored',
  'right-censored': 'rightCensored',
  unobserved: 'unobserved',
} satisfies Record<SegmentCompleteness, ProfilerLocaleKey>

/**
 * 提供方就绪与解除阻塞之间允许的间隔。
 *
 * 归因正确时这两件事几乎同时发生。间隔超过这个值,说明真正卡住它的东西不在已观测
 * 到的依赖里,界面把这类归因标成存疑,而不是当成结论。
 */
export const ATTRIBUTION_SKEW_LIMIT_MS = 50

/** 返回完整的激活耗时，不计入被截断的观测值。 */
export function activationDurations(samples: readonly ActivationSample[]): number[] {
  return samples.flatMap(sample => {
    const segment = sample.segments.activation
    return segment.completeness === 'complete' && segment.durationMs !== null
      ? [segment.durationMs]
      : []
  })
}

/**
 * 排名用的自身耗时。
 *
 * 容器条目被排除:它的耗时来自子条目,把它算进"最慢插件"只会盖住真正的那一个。
 */
export function rankableSelfDuration(sample: ActivationSample): number | null {
  if (sample.isGroup) return null
  return sample.selfTime.durationMs
}

/** 自身耗时最高的插件,也就是这个页面存在的理由。 */
export function slowestBySelfTime(
  samples: readonly ActivationSample[],
): ActivationSample | undefined {
  let slowest: ActivationSample | undefined
  let best = Number.NEGATIVE_INFINITY
  for (const sample of samples) {
    const duration = rankableSelfDuration(sample)
    if (duration === null || duration <= best) continue
    best = duration
    slowest = sample
  }
  return slowest
}

/** 使用线性插值计算有限数值的分位数。 */
export function quantile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  const bounded = Math.min(1, Math.max(0, ratio))
  const position = (sorted.length - 1) * bounded
  const lowerIndex = Math.floor(position)
  const upperIndex = Math.ceil(position)
  const lower = sorted[lowerIndex]
  const upper = sorted[upperIndex]
  if (lower === undefined || upper === undefined) return null
  return lower + (upper - lower) * (position - lowerIndex)
}

export function formatDuration(value: number | null): string {
  if (value === null) return '—'
  if (value < 10) return value.toFixed(1) + ' ms'
  return Math.round(value) + ' ms'
}

/** 将未知异常转换为适合在诊断区域展示的文本。 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error) ?? String(error)
  } catch {
    return String(error)
  }
}

/** 导出文件名带上时间,方便把两次启动的快照放在一起比较。 */
export function snapshotFileName(at: Date): string {
  return 'dsh-profiler-' + at.toISOString().replace(/[:.]/g, '-') + '.json'
}

function downloadSnapshot(snapshot: ProfilerSnapshot): void {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return

  const url = URL.createObjectURL(
    new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' }),
  )
  const link = document.createElement('a')
  link.href = url
  link.download = snapshotFileName(new Date())
  document.body.appendChild(link)
  link.click()
  link.remove()
  URL.revokeObjectURL(url)
}

function displayName(sample: ActivationSample): string {
  return sample.moduleName ?? sample.entryId
}

/** entryId -> 展示名,用来把归因里的条目 id 换成人能读的名字。 */
function namesByEntryId(samples: readonly ActivationSample[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const sample of samples) names.set(sample.entryId, displayName(sample))
  return names
}

function compareNullableDesc(left: number | null, right: number | null): number {
  if (left === right) return 0
  if (left === null) return 1
  if (right === null) return -1
  return right - left
}

function sortedSamples(samples: readonly ActivationSample[]): ActivationSample[] {
  return [...samples].sort((left, right) => {
    const bySelf = compareNullableDesc(rankableSelfDuration(left), rankableSelfDuration(right))
    if (bySelf !== 0) return bySelf

    const byTotal = compareNullableDesc(
      left.segments.activation.durationMs,
      right.segments.activation.durationMs,
    )
    if (byTotal !== 0) return byTotal

    return right.lastSeenOffsetMs - left.lastSeenOffsetMs
  })
}

/** 统计每个筛选项下的插件数(按 entryId 去重),用于渲染筛选项上的计数。 */
export function originFilterCounts(
  snapshot: ProfilerSnapshot,
): Readonly<Record<OriginFilter, number>> {
  const { builtin, user, unknown } = snapshot.provenance.counts
  return { all: builtin + user + unknown, builtin, user, unknown }
}

function matchesOrigin(sample: ActivationSample, filter: OriginFilter): boolean {
  return filter === 'all' || sample.origin === filter
}

function matches(sample: ActivationSample, normalizedQuery: string): boolean {
  if (normalizedQuery.length === 0) return true
  return [
    sample.entryId,
    sample.moduleName ?? '',
    sample.outcome,
  ].some(value => value.toLocaleLowerCase().includes(normalizedQuery))
}

function SegmentValue({
  duration,
  completeness,
  t,
}: {
  readonly duration: number | null
  readonly completeness: SegmentCompleteness
  readonly t: ProfilerSettingsTabProps['t']
}): ReactNode {
  return (
    <span
      className="dpp-duration dpp-number"
      data-complete={completeness === 'complete' ? 'true' : 'false'}
      title={t(COMPLETENESS_KEYS[completeness])}
    >
      {formatDuration(duration)}
    </span>
  )
}

function SelfTimeValue({
  sample,
  t,
}: {
  readonly sample: ActivationSample
  readonly t: ProfilerSettingsTabProps['t']
}): ReactNode {
  const { durationMs, basis, childEntryCount } = sample.selfTime
  const text = formatDuration(durationMs)
  return (
    <span className="dpp-cell">
      <span
        className="dpp-duration dpp-number"
        data-complete={basis === 'exact' ? 'true' : 'false'}
        title={t(SELF_TIME_KEYS[basis])}
      >
        {basis === 'upper-bound' && durationMs !== null ? '≤ ' + text : text}
      </span>
      {childEntryCount > 0
        ? <small className="dpp-sub">{t('children') + ' ' + childEntryCount}</small>
        : null}
    </span>
  )
}

function WaitValue({
  sample,
  names,
  t,
}: {
  readonly sample: ActivationSample
  readonly names: ReadonlyMap<string, string>
  readonly t: ProfilerSettingsTabProps['t']
}): ReactNode {
  const wait = sample.segments.dependencyWait
  const blockedBy = sample.blockedBy
  const confident = blockedBy !== undefined && blockedBy.skewMs <= ATTRIBUTION_SKEW_LIMIT_MS

  return (
    <span className="dpp-cell">
      <SegmentValue duration={wait.durationMs} completeness={wait.completeness} t={t} />
      {blockedBy === undefined ? null : (
        <small
          className="dpp-sub"
          data-confident={confident ? 'true' : 'false'}
          title={(confident ? t('unblockedBy') : t('attributionUncertain'))
            + ' · ' + blockedBy.service + ' · ' + formatDuration(blockedBy.skewMs)}
        >
          {'← ' + (names.get(blockedBy.entryId) ?? blockedBy.entryId)}
        </small>
      )}
    </span>
  )
}

export function ProfilerSettingsTab({ readSnapshot, t }: ProfilerSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [refreshing, setRefreshing] = useState(false)
  const [state, setState] = useState<ViewState>({ status: 'loading' })

  useEffect(() => {
    let current = true
    void Promise.resolve().then(() => readSnapshot()).then(
      snapshot => {
        if (!current) return
        setState({ status: 'ready', snapshot })
        setRefreshing(false)
      },
      error => {
        if (!current) return
        setState({ status: 'error', message: describeError(error) })
        setRefreshing(false)
      },
    )
    return () => { current = false }
  }, [readSnapshot, request])

  const snapshot = state.status === 'ready' ? state.snapshot : null

  // 归属筛选决定统计范围,搜索只在该范围内查找,所以指标跟着筛选走、不跟着搜索走。
  const scopedSamples = useMemo(
    () => snapshot === null ? [] : snapshot.samples.filter(sample => matchesOrigin(sample, origin)),
    [origin, snapshot],
  )
  const durations = useMemo(() => activationDurations(scopedSamples), [scopedSamples])
  const slowest = useMemo(() => slowestBySelfTime(scopedSamples), [scopedSamples])
  const names = useMemo(
    () => snapshot === null ? new Map<string, string>() : namesByEntryId(snapshot.samples),
    [snapshot],
  )
  const visibleSamples = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return sortedSamples(scopedSamples).filter(sample => matches(sample, normalizedQuery))
  }, [query, scopedSamples])

  const originCounts = useMemo(
    () => snapshot === null ? null : originFilterCounts(snapshot),
    [snapshot],
  )

  const refresh = (): void => {
    setRefreshing(true)
    setRequest(value => value + 1)
  }

  const retry = (): void => {
    setState({ status: 'loading' })
    setRequest(value => value + 1)
  }

  return (
    <div className="dpp-root" aria-busy={state.status === 'loading' || refreshing}>
      <div className="dpp-hero">
        <div className="dpp-heading">
          <p className="dpp-eyebrow">{t('eyebrow')}</p>
          <h3 className="dpp-title">{t('title')}</h3>
          <p className="dpp-subtitle">{t('subtitle')}</p>
        </div>
        <div className="dpp-actions">
          <span className="dpp-badge">{t('partial')}</span>
          {snapshot !== null ? (
            <button
              className="dpp-button"
              type="button"
              onClick={() => { downloadSnapshot(snapshot) }}
            >
              {t('export')}
            </button>
          ) : null}
          {state.status === 'ready' ? (
            <button className="dpp-button" type="button" disabled={refreshing} onClick={refresh}>
              {refreshing ? t('refreshing') : t('refresh')}
            </button>
          ) : null}
        </div>
      </div>

      {state.status === 'loading' ? <p className="dpp-status">{t('loading')}</p> : null}
      {state.status === 'error' ? (
        <div className="dpp-failure">
          <div className="dpp-failure-copy" role="alert">
            <p className="dpp-status">{t('error')}</p>
            <code className="dpp-error-detail">{state.message}</code>
          </div>
          <button className="dpp-button" type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}

      {snapshot !== null ? (
        <>
          <div className="dpp-metrics">
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('measured')}</span>
              <strong className="dpp-metric-value">
                {durations.length + '/' + scopedSamples.length}
              </strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('slowest')}</span>
              <strong className="dpp-metric-value">
                {formatDuration(slowest === undefined ? null : slowest.selfTime.durationMs)}
              </strong>
              <span
                className="dpp-metric-note"
                title={slowest === undefined ? undefined : displayName(slowest)}
              >
                {slowest === undefined ? '—' : displayName(slowest)}
              </span>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('failures')}</span>
              <strong className="dpp-metric-value">
                {scopedSamples.filter(sample => sample.outcome === 'failed').length}
              </strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('window')}</span>
              <strong className="dpp-metric-value">
                {formatDuration(snapshot.collector.observedUntilOffsetMs)}
              </strong>
            </div>
          </div>

          <p className="dpp-notice">{t('notice')}</p>

          {snapshot.provenance.resolved && originCounts !== null ? (
            <div className="dpp-filters" role="group" aria-label={t('origin')}>
              {ORIGIN_FILTERS.filter(
                filter => filter === 'all' || originCounts[filter] > 0,
              ).map(filter => (
                <button
                  key={filter}
                  className="dpp-chip"
                  type="button"
                  aria-pressed={origin === filter}
                  data-active={origin === filter ? 'true' : 'false'}
                  onClick={() => { setOrigin(filter) }}
                >
                  {(filter === 'all' ? t('originAll') : t(ORIGIN_KEYS[filter]))
                    + ' · ' + originCounts[filter]}
                </button>
              ))}
            </div>
          ) : <p className="dpp-notice">{t('originUnavailable')}</p>}

          <div className="dpp-toolbar">
            <input
              className="dpp-search"
              type="search"
              value={query}
              aria-label={t('search')}
              placeholder={t('search')}
              onChange={event => { setQuery(event.currentTarget.value) }}
            />
            <span className="dpp-meta">
              {(snapshot.provenance.profileName === undefined
                ? ''
                : t('profile') + ' ' + snapshot.provenance.profileName + ' · ')
                + t('target') + ' ' + snapshot.collector.target.dshVersion
                + ' · ' + t('median') + ' ' + formatDuration(quantile(durations, 0.5))
                + ' · ' + t('p95') + ' ' + formatDuration(quantile(durations, 0.95))
                + ' · ' + t('diagnostics') + ' ' + snapshot.diagnostics.total}
            </span>
          </div>

          {snapshot.samples.length === 0 ? <p className="dpp-status">{t('empty')}</p> : null}
          {snapshot.samples.length > 0 && visibleSamples.length === 0
            ? (
              <p className="dpp-status">
                {query.trim() === '' ? t('emptyFilter') : t('emptySearch')}
              </p>
            )
            : null}

          {visibleSamples.length > 0 ? (
            <div className="dpp-table-wrap">
              <table className="dpp-table">
                <thead>
                  <tr>
                    <th>{t('plugin')}</th>
                    <th>{t('origin')}</th>
                    <th>{t('selfTime')}</th>
                    <th>{t('activation')}</th>
                    <th>{t('dependencyWait')}</th>
                    <th>{t('outcome')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSamples.map(sample => (
                    <tr key={sample.runId} data-group={sample.isGroup ? 'true' : 'false'}>
                      <td>
                        <span className="dpp-plugin">
                          <strong title={displayName(sample)}>
                            <span className="dpp-name">{displayName(sample)}</span>
                            {sample.isGroup
                              ? <span className="dpp-tag" data-tag="group">{t('group')}</span>
                              : null}
                            {sample.generation > 1
                              ? (
                                <span className="dpp-tag" data-tag="reload" title={t('generation')}>
                                  {t('reloaded') + ' ×' + sample.generation}
                                </span>
                              )
                              : null}
                          </strong>
                          <code title={sample.entryId}>{sample.entryId}</code>
                        </span>
                      </td>
                      <td>
                        <span className="dpp-origin" data-origin={sample.origin}>
                          {t(ORIGIN_KEYS[sample.origin])}
                        </span>
                      </td>
                      <td><SelfTimeValue sample={sample} t={t} /></td>
                      <td>
                        <SegmentValue
                          duration={sample.segments.activation.durationMs}
                          completeness={sample.segments.activation.completeness}
                          t={t}
                        />
                      </td>
                      <td><WaitValue sample={sample} names={names} t={t} /></td>
                      <td>
                        <span className="dpp-outcome" data-outcome={sample.outcome}>
                          {t(OUTCOME_KEYS[sample.outcome])}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
