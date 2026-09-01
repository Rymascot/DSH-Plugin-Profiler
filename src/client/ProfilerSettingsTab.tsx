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

/** 归属筛选项。只在展开后的完整视图里出现。 */
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

/** 把 `{name}` 之类的占位符填上。中英文语序不同,只能整句给模板。 */
export function fill(
  template: string,
  values: Readonly<Record<string, string | number>>,
): string {
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) => {
    const value = values[name]
    return value === undefined ? match : String(value)
  })
}

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
 * 每个插件只保留最近一次激活。
 *
 * 一个插件可能重载过好几次,而用户关心的是"它现在好不好",不是它第一次起来时
 * 怎么样。开发者要看全部代次,那是展开视图的事。
 */
export function latestByEntry(samples: readonly ActivationSample[]): ActivationSample[] {
  const latest = new Map<string, ActivationSample>()
  for (const sample of samples) {
    const current = latest.get(sample.entryId)
    if (current === undefined || sample.generation > current.generation) {
      latest.set(sample.entryId, sample)
    }
  }
  return [...latest.values()]
}

/** 默认视图要下的那个结论。 */
export interface UserPluginVerdict {
  readonly tone: 'none' | 'ok' | 'unfinished' | 'failed'
  readonly pluginCount: number
  readonly failedCount: number
  readonly unfinishedCount: number
  /** 只有一个出问题时才给名字;更多时给数量,免得句子变成一串清单。 */
  readonly onlyName?: string
  /** 有多少个插件测到了耗时。为 0 时那句话得说明白,否则「都正常」听着像有数据。 */
  readonly timedCount: number
  /** 每个插件都测到耗时才有总和,否则宁可不说,也不给个偏小的数。 */
  readonly totalSelfMs: number | null
}

export function userPluginVerdict(
  userSamples: readonly ActivationSample[],
): UserPluginVerdict {
  const plugins = latestByEntry(userSamples)
  if (plugins.length === 0) {
    return {
      tone: 'none',
      pluginCount: 0,
      failedCount: 0,
      unfinishedCount: 0,
      timedCount: 0,
      totalSelfMs: null,
    }
  }

  const failed = plugins.filter(sample => sample.outcome === 'failed')
  const unfinished = plugins.filter(
    sample => sample.outcome === 'in-progress' || sample.outcome === 'disposed-before-terminal',
  )

  let totalSelfMs: number | null = 0
  for (const plugin of plugins) {
    const duration = plugin.selfTime.durationMs
    if (duration === null || totalSelfMs === null) {
      totalSelfMs = null
      continue
    }
    totalSelfMs += duration
  }

  const troubled = failed.length > 0 ? failed : unfinished
  const onlyName = troubled.length === 1 && troubled[0] !== undefined
    ? displayName(troubled[0])
    : undefined

  return {
    tone: failed.length > 0 ? 'failed' : unfinished.length > 0 ? 'unfinished' : 'ok',
    pluginCount: plugins.length,
    failedCount: failed.length,
    unfinishedCount: unfinished.length,
    timedCount: plugins.filter(sample => sample.selfTime.durationMs !== null).length,
    ...(onlyName === undefined ? {} : { onlyName }),
    totalSelfMs,
  }
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

/**
 * 为什么这一行没有耗时。
 *
 * 「没测到」有两种成因,而它们在页面上长得一模一样(都是 —)。不说清楚,用户只会
 * 看到两行同样的破折号,其中一行莫名带着标签。
 */
export function untimedReasonKey(sample: ActivationSample): ProfilerLocaleKey {
  return sample.observation === 'enumerated' ? 'untimedRoster' : 'untimedCensored'
}

/**
 * 按插件数(而不是记录数)统计有多少个测到了耗时。
 *
 * 归属筛选上的计数是"多少个插件",这里必须用同一把尺子。一个说 141 一个说 152,
 * 哪怕两个都对,并排放着也只会让人以为出了错。
 */
export function timedPluginCounts(
  samples: readonly ActivationSample[],
): { readonly timed: number; readonly total: number } {
  const plugins = latestByEntry(samples)
  return {
    timed: plugins.filter(sample => sample.selfTime.durationMs !== null).length,
    total: plugins.length,
  }
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
        title={durationMs === null ? t(untimedReasonKey(sample)) : t(SELF_TIME_KEYS[basis])}
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

function PluginName({
  sample,
  t,
}: {
  readonly sample: ActivationSample
  readonly t: ProfilerSettingsTabProps['t']
}): ReactNode {
  return (
    <span className="dpp-plugin">
      <strong title={displayName(sample)}>
        <span className="dpp-name">{displayName(sample)}</span>
        {sample.selfTime.durationMs === null
          ? (
            <span className="dpp-tag" data-tag="untimed" title={t(untimedReasonKey(sample))}>
              {t('untimedTag')}
            </span>
          )
          : null}
        {sample.isGroup ? <span className="dpp-tag" data-tag="group">{t('group')}</span> : null}
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
  )
}

function verdictText(
  verdict: UserPluginVerdict,
  t: ProfilerSettingsTabProps['t'],
): string {
  if (verdict.tone === 'none') return t('verdictNone')

  if (verdict.tone === 'failed') {
    return verdict.onlyName === undefined
      ? fill(t('verdictFailedMany'), { count: verdict.failedCount })
      : fill(t('verdictFailedOne'), { name: verdict.onlyName })
  }

  if (verdict.tone === 'unfinished') {
    return verdict.onlyName === undefined
      ? fill(t('verdictUnfinishedMany'), { count: verdict.unfinishedCount })
      : fill(t('verdictUnfinishedOne'), { name: verdict.onlyName })
  }

  // 一个都没测到的时候,「都正常」听着像背后有数据支撑。得说清楚是怎么回事。
  if (verdict.timedCount === 0) return fill(t('verdictOkUntimed'), { count: verdict.pluginCount })

  return verdict.totalSelfMs === null
    ? fill(t('verdictOk'), { count: verdict.pluginCount })
    : fill(t('verdictOkTotal'), {
      count: verdict.pluginCount,
      total: formatDuration(verdict.totalSelfMs),
    })
}

export function ProfilerSettingsTab({ readSnapshot, t }: ProfilerSettingsTabProps): ReactNode {
  const [request, setRequest] = useState(0)
  const [query, setQuery] = useState('')
  const [origin, setOrigin] = useState<OriginFilter>('all')
  const [expanded, setExpanded] = useState(false)
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

  // 读不到 Profile 清单就分不清哪个是用户装的,默认视图无从谈起,直接给完整视图。
  const resolved = snapshot !== null && snapshot.provenance.resolved
  const showAll = expanded || !resolved

  const userPlugins = useMemo(
    () => snapshot === null
      ? []
      : sortedSamples(latestByEntry(snapshot.samples.filter(sample => sample.origin === 'user'))),
    [snapshot],
  )
  const verdict = useMemo(() => userPluginVerdict(userPlugins), [userPlugins])

  // 展开视图的统计跟着归属筛选走,不跟着搜索走。
  const scopedSamples = useMemo(
    () => snapshot === null ? [] : snapshot.samples.filter(sample => matchesOrigin(sample, origin)),
    [origin, snapshot],
  )
  const durations = useMemo(() => activationDurations(scopedSamples), [scopedSamples])
  const timedCounts = useMemo(() => timedPluginCounts(scopedSamples), [scopedSamples])
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

      {snapshot !== null && resolved ? (
        <>
          <div className="dpp-verdict" data-tone={verdict.tone}>
            <p className="dpp-verdict-text">{verdictText(verdict, t)}</p>
            {snapshot.provenance.counts.builtin > 0 ? (
              <p className="dpp-verdict-note">
                {fill(t('verdictBuiltinNote'), { count: snapshot.provenance.counts.builtin })}
              </p>
            ) : null}
            {/* 不提这批的话,「2 + 135」就凑不出筛选条上的总数,读得仔细的人立刻会发现。 */}
            {snapshot.provenance.counts.unknown > 0 ? (
              <p className="dpp-verdict-note">
                {fill(t('verdictUnknownNote'), { count: snapshot.provenance.counts.unknown })}
              </p>
            ) : null}
          </div>

          {userPlugins.length > 0 ? (
            <div className="dpp-table-wrap">
              <table className="dpp-table">
                <thead>
                  <tr>
                    <th>{t('plugin')}</th>
                    <th>{t('duration')}</th>
                    <th>{t('outcome')}</th>
                  </tr>
                </thead>
                <tbody>
                  {userPlugins.map(sample => (
                    <tr key={sample.runId}>
                      <td><PluginName sample={sample} t={t} /></td>
                      <td><SelfTimeValue sample={sample} t={t} /></td>
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

          <div className="dpp-expand">
            <button
              className="dpp-button"
              type="button"
              aria-expanded={expanded}
              onClick={() => { setExpanded(value => !value) }}
            >
              {expanded
                ? t('hideAll')
                : t('showAll') + ' · ' + (originCounts === null ? 0 : originCounts.all)}
            </button>
          </div>
        </>
      ) : null}

      {snapshot !== null && showAll ? (
        <>
          {resolved ? null : <p className="dpp-notice">{t('originUnavailable')}</p>}

          <div className="dpp-metrics">
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('measured')}</span>
              <strong className="dpp-metric-value">
                {timedCounts.timed + '/' + timedCounts.total}
              </strong>
              <span className="dpp-metric-note">
                {fill(t('activationRuns'), { count: scopedSamples.length })}
              </span>
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
            {/* 挂载时机解释了页面上大半个「无计时」:这段时间里发生的事全都没赶上。 */}
            <div className="dpp-metric">
              <span className="dpp-metric-label">{t('attachedAfter')}</span>
              <strong className="dpp-metric-value">
                {formatDuration(snapshot.collector.attachedAtMonotonicMs)}
              </strong>
              <span className="dpp-metric-note">
                {fill(t('observedFor'), {
                  duration: formatDuration(snapshot.collector.observedUntilOffsetMs),
                })}
              </span>
            </div>
          </div>

          {resolved && originCounts !== null ? (
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
          ) : null}

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
                      <td><PluginName sample={sample} t={t} /></td>
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
