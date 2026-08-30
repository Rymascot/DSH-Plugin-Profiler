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

/** 归属筛选项。`all` 是默认值:先看"谁最慢",再决定要不要缩到自己的插件。 */
export type OriginFilter = PluginOrigin | 'all'

const ORIGIN_FILTERS: readonly OriginFilter[] = ['all', 'user', 'builtin', 'unknown']

const COMPLETENESS_KEYS = {
  complete: 'complete',
  'left-censored': 'leftCensored',
  'right-censored': 'rightCensored',
  unobserved: 'unobserved',
} satisfies Record<SegmentCompleteness, ProfilerLocaleKey>

/** 返回完整的激活耗时，不计入被截断的观测值。 */
export function activationDurations(samples: readonly ActivationSample[]): number[] {
  return samples.flatMap(sample => {
    const segment = sample.segments.activation
    return segment.completeness === 'complete' && segment.durationMs !== null
      ? [segment.durationMs]
      : []
  })
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

function displayName(sample: ActivationSample): string {
  return sample.moduleName ?? sample.entryId
}

function sortedSamples(samples: readonly ActivationSample[]): ActivationSample[] {
  return [...samples].sort((left, right) => {
    const leftDuration = left.segments.activation.durationMs
    const rightDuration = right.segments.activation.durationMs
    if (leftDuration === null && rightDuration !== null) return 1
    if (leftDuration !== null && rightDuration === null) return -1
    if (leftDuration !== null && rightDuration !== null && leftDuration !== rightDuration) {
      return rightDuration - leftDuration
    }
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
              <span className="dpp-metric-label">{t('samples')}</span>
              <strong className="dpp-metric-value">{scopedSamples.length}</strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('measured')}</span>
              <strong className="dpp-metric-value">{durations.length + '/' + scopedSamples.length}</strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('median')}</span>
              <strong className="dpp-metric-value">{formatDuration(quantile(durations, 0.5))}</strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('p95') + ' · ' + t('failures')}</span>
              <strong className="dpp-metric-value">
                {formatDuration(quantile(durations, 0.95)) + ' · '
                  + scopedSamples.filter(sample => sample.outcome === 'failed').length}
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
                    <th>{t('generation')}</th>
                    <th>{t('dependencyWait')}</th>
                    <th>{t('activation')}</th>
                    <th>{t('outcome')}</th>
                    <th>{t('coverage')}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSamples.map(sample => (
                    <tr key={sample.runId}>
                      <td>
                        <span className="dpp-plugin">
                          <strong title={displayName(sample)}>{displayName(sample)}</strong>
                          <code title={sample.entryId}>{sample.entryId}</code>
                        </span>
                      </td>
                      <td>
                        <span className="dpp-origin" data-origin={sample.origin}>
                          {t(ORIGIN_KEYS[sample.origin])}
                        </span>
                      </td>
                      <td className="dpp-number">{sample.generation}</td>
                      <td>
                        <SegmentValue
                          duration={sample.segments.dependencyWait.durationMs}
                          completeness={sample.segments.dependencyWait.completeness}
                          t={t}
                        />
                      </td>
                      <td>
                        <SegmentValue
                          duration={sample.segments.activation.durationMs}
                          completeness={sample.segments.activation.completeness}
                          t={t}
                        />
                      </td>
                      <td>
                        <span className="dpp-outcome" data-outcome={sample.outcome}>
                          {t(OUTCOME_KEYS[sample.outcome])}
                        </span>
                      </td>
                      <td>{t(COMPLETENESS_KEYS[sample.segments.activation.completeness])}</td>
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
