import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  createOriginIndex,
  unresolvedOriginIndex,
  type OriginIndex,
  type ProfileManifestFacts,
} from '../core/provenance.js'

/**
 * Loader 把 `ctx.baseUrl` 锚定在 Profile 目录上,并以尾部带 `/` 的 file URL 形式
 * 沿 Context 继承链向下传递,所以插件自身的 ctx 上就能读到它。
 *
 * 这是本文件与 DSH 内部约定的唯一耦合点,和 `cordis-internal.ts` 一样属于
 * 版本敏感面,升级 DSH 时需要重新确认。
 */
export interface ProfileAnchorLike {
  readonly baseUrl?: unknown
}

/** 供测试替换的最小文件读取面。 */
export interface ManifestReader {
  readText(path: string): string
}

const nodeReader: ManifestReader = {
  readText: path => readFileSync(path, 'utf8'),
}

interface RawManifest {
  readonly name?: unknown
  readonly dependencies?: unknown
  readonly dsh?: {
    readonly profile?: {
      readonly bundles?: unknown
    }
  }
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
}

function dependencyNames(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.keys(value as Record<string, unknown>)
}

/** 把 Profile 目录的 file URL 还原成本地路径。 */
export function profileDirFromBaseUrl(baseUrl: unknown): string | undefined {
  if (typeof baseUrl !== 'string' || !baseUrl.startsWith('file:')) return undefined
  try {
    const path = fileURLToPath(baseUrl)
    // baseUrl 以 `/` 结尾时 fileURLToPath 会保留尾部分隔符,join 会归一化掉。
    return join(path, '.')
  } catch {
    return undefined
  }
}

/** 解析 Profile package.json,失败时返回 undefined 而不是抛错。 */
export function readProfileManifestFacts(
  profileDir: string,
  reader: ManifestReader = nodeReader,
): ProfileManifestFacts | undefined {
  let raw: RawManifest
  try {
    raw = JSON.parse(reader.readText(join(profileDir, 'package.json'))) as RawManifest
  } catch {
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) return undefined

  const profileName = typeof raw.name === 'string' && raw.name.trim() !== ''
    ? raw.name.trim()
    : undefined

  return {
    ...(profileName === undefined ? {} : { profileName }),
    bundles: stringList(raw.dsh?.profile?.bundles),
    dependencies: dependencyNames(raw.dependencies),
  }
}

/**
 * 从插件自己的 Context 推导归属索引。
 *
 * 任何一步失败都降级成"未判定":归属只是给界面分层用的,读不到清单不应该让
 * 采集本身失效。
 */
export function createProfileOriginIndex(
  ctx: ProfileAnchorLike,
  reader: ManifestReader = nodeReader,
): OriginIndex {
  const profileDir = profileDirFromBaseUrl(ctx.baseUrl)
  if (profileDir === undefined) {
    return unresolvedOriginIndex('Context 上没有可用的 Profile 目录锚点 (ctx.baseUrl)。')
  }

  const facts = readProfileManifestFacts(profileDir, reader)
  if (facts === undefined) {
    return unresolvedOriginIndex('无法读取 Profile 的 package.json。')
  }

  return createOriginIndex(facts)
}
