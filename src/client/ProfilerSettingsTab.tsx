import { useEffect, useMemo, useState, type ReactNode } from 'react'

import type { ActivationSample, ProfilerSnapshot, SegmentCompleteness } from '../core/types.js'
import type { ProfilerLocaleKey } from './locales.js'
import type { ProfilerSettingsTabProps } from './contracts.js'

type ViewState =
  | { readonly status: 'loading' }
  | { readonly status: 'error' }
  | { readonly status: 'ready'; readonly snapshot: ProfilerSnapshot }

const OUTCOME_KEYS = {
  active: 'active',
  failed: 'failed',
  'in-progress': 'inProgress',
  'disposed-before-terminal': 'disposedBeforeTerminal',
} satisfies Record<ActivationSample['outcome'], ProfilerLocaleKey>

const COMPLETENESS_KEYS = {
  complete: 'complete',
  'left-censored': 'leftCensored',
  'right-censored': 'rightCensored',
  unobserved: 'unobserved',
} satisfies Record<SegmentCompleteness, ProfilerLocaleKey>

/** Complete activation durations, excluding censored observations. */
export function activationDurations(snapshot: ProfilerSnapshot): number[] {
  return snapshot.samples.flatMap(sample => {
    const segment = sample.segments.activation
    return segment.completeness === 'complete' && segment.durationMs !== null
      ? [segment.durationMs]
      : []
  })
}

/** Linearly interpolated quantile over finite values. */
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
      () => {
        if (!current) return
        setState({ status: 'error' })
        setRefreshing(false)
      },
    )
    return () => { current = false }
  }, [readSnapshot, request])

  const snapshot = state.status === 'ready' ? state.snapshot : null
  const durations = useMemo(
    () => snapshot === null ? [] : activationDurations(snapshot),
    [snapshot],
  )
  const visibleSamples = useMemo(() => {
    if (snapshot === null) return []
    const normalizedQuery = query.trim().toLocaleLowerCase()
    return sortedSamples(snapshot.samples).filter(sample => matches(sample, normalizedQuery))
  }, [query, snapshot])

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
          <p className="dpp-status" role="alert">{t('error')}</p>
          <button className="dpp-button" type="button" onClick={retry}>{t('retry')}</button>
        </div>
      ) : null}

      {snapshot !== null ? (
        <>
          <div className="dpp-metrics">
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('samples')}</span>
              <strong className="dpp-metric-value">{snapshot.samples.length}</strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('measured')}</span>
              <strong className="dpp-metric-value">{durations.length + '/' + snapshot.samples.length}</strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('median')}</span>
              <strong className="dpp-metric-value">{formatDuration(quantile(durations, 0.5))}</strong>
            </div>
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('p95') + ' · ' + t('failures')}</span>
              <strong className="dpp-metric-value">
                {formatDuration(quantile(durations, 0.95)) + ' · '
                  + snapshot.samples.filter(sample => sample.outcome === 'failed').length}
              </strong>
            </div>
          </div>

          <p className="dpp-notice">{t('notice')}</p>

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
              {t('target') + ' ' + snapshot.collector.target.dshVersion
                + ' · ' + t('diagnostics') + ' ' + snapshot.diagnostics.total}
            </span>
          </div>

          {snapshot.samples.length === 0 ? <p className="dpp-status">{t('empty')}</p> : null}
          {snapshot.samples.length > 0 && visibleSamples.length === 0
            ? <p className="dpp-status">{t('emptySearch')}</p>
            : null}

          {visibleSamples.length > 0 ? (
            <div className="dpp-table-wrap">
              <table className="dpp-table">
                <thead>
                  <tr>
                    <th>{t('plugin')}</th>
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
