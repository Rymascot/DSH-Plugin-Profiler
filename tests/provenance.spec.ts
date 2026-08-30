import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  createProfileOriginIndex,
  profileDirFromBaseUrl,
  readProfileManifestFacts,
  type ManifestReader,
} from '../src/adapters/profile-manifest.js'
import { createOriginIndex, packageNameOf } from '../src/core/provenance.js'

/** 取自 D:\DSH\home\profiles\web 的真实形状:两个自带 Bundle 加一个链接安装的插件。 */
const WEB_PROFILE = JSON.stringify({
  name: 'dsh-profile-web',
  private: true,
  dependencies: { 'dsh-plugin-profiler': 'link:D:/DSH/Plugin/DSH-Plugin-Profiler' },
  dsh: {
    profile: {
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-profiler'],
    },
  },
})

function readerFor(files: Record<string, string>): ManifestReader {
  return {
    readText(path) {
      const content = files[path]
      if (content === undefined) throw new Error('ENOENT: ' + path)
      return content
    },
  }
}

describe('packageNameOf', () => {
  it('把子路径还原成包名', () => {
    expect(packageNameOf('@deepseek-ai/dsh-llm')).toBe('@deepseek-ai/dsh-llm')
    expect(packageNameOf('@deepseek-ai/dsh-llm/client')).toBe('@deepseek-ai/dsh-llm')
    expect(packageNameOf('dsh-plugin-profiler')).toBe('dsh-plugin-profiler')
    expect(packageNameOf('dsh-plugin-profiler/core')).toBe('dsh-plugin-profiler')
  })

  it('对空值和残缺的作用域名返回空串', () => {
    expect(packageNameOf('')).toBe('')
    expect(packageNameOf('   ')).toBe('')
    expect(packageNameOf('@deepseek-ai')).toBe('')
  })
})

describe('createOriginIndex', () => {
  const index = createOriginIndex({
    profileName: 'dsh-profile-web',
    bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-profiler'],
    dependencies: ['dsh-plugin-profiler'],
  })

  it('把 @deepseek-ai 作用域下未安装的包判为内置', () => {
    expect(index.originOf('@deepseek-ai/dsh-llm')).toBe('builtin')
    expect(index.originOf('@deepseek-ai/cordis-plugin-timer')).toBe('builtin')
  })

  it('把 Profile dependencies 里的包判为用户安装', () => {
    expect(index.originOf('dsh-plugin-profiler')).toBe('user')
  })

  it('无法归类时返回 unknown 而不是猜测', () => {
    expect(index.originOf('some-third-party-plugin')).toBe('unknown')
    expect(index.originOf(undefined)).toBe('unknown')
  })

  it('显式安装优先于包名前缀', () => {
    const shadowed = createOriginIndex({
      bundles: [],
      dependencies: ['@deepseek-ai/dsh-llm'],
    })
    expect(shadowed.originOf('@deepseek-ai/dsh-llm')).toBe('user')
  })

  it('按是否出现在 dependencies 里区分 Bundle 层的归属', () => {
    expect(index.source.resolved).toBe(true)
    expect(index.source.profileName).toBe('dsh-profile-web')
    expect(index.source.bundles).toEqual([
      { packageName: '@deepseek-ai/dsh-base', origin: 'builtin' },
      { packageName: '@deepseek-ai/dsh-web-app', origin: 'builtin' },
      { packageName: 'dsh-plugin-profiler', origin: 'user' },
    ])
  })
})

describe('profileDirFromBaseUrl', () => {
  it('还原 Loader 锚定的 Profile 目录', () => {
    const dir = join('D:', 'DSH', 'home', 'profiles', 'web')
    const baseUrl = pathToFileURL(dir).href + '/'
    expect(profileDirFromBaseUrl(baseUrl)).toBe(dir)
  })

  it('对非 file URL 和非字符串返回 undefined', () => {
    expect(profileDirFromBaseUrl('https://example.invalid/')).toBeUndefined()
    expect(profileDirFromBaseUrl(undefined)).toBeUndefined()
    expect(profileDirFromBaseUrl(42)).toBeUndefined()
  })
})

describe('readProfileManifestFacts', () => {
  const dir = join('D:', 'DSH', 'home', 'profiles', 'web')
  const manifestPath = join(dir, 'package.json')

  it('读出 Bundle 列表和依赖名', () => {
    const facts = readProfileManifestFacts(dir, readerFor({ [manifestPath]: WEB_PROFILE }))
    expect(facts).toEqual({
      profileName: 'dsh-profile-web',
      bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-plugin-profiler'],
      dependencies: ['dsh-plugin-profiler'],
    })
  })

  it('容忍缺失的 dsh 段和 dependencies', () => {
    const facts = readProfileManifestFacts(
      dir,
      readerFor({ [manifestPath]: JSON.stringify({ name: 'bare' }) }),
    )
    expect(facts).toEqual({ profileName: 'bare', bundles: [], dependencies: [] })
  })

  it('读不到或解析失败时返回 undefined', () => {
    expect(readProfileManifestFacts(dir, readerFor({}))).toBeUndefined()
    expect(readProfileManifestFacts(dir, readerFor({ [manifestPath]: '{ not json' })))
      .toBeUndefined()
  })
})

describe('createProfileOriginIndex', () => {
  it('从 ctx.baseUrl 解析出完整归属', () => {
    const dir = join('D:', 'DSH', 'home', 'profiles', 'web')
    const index = createProfileOriginIndex(
      { baseUrl: pathToFileURL(dir).href + '/' },
      readerFor({ [join(dir, 'package.json')]: WEB_PROFILE }),
    )

    expect(index.source.resolved).toBe(true)
    expect(index.originOf('dsh-plugin-profiler')).toBe('user')
    expect(index.originOf('@deepseek-ai/dsh-session')).toBe('builtin')
  })

  it('缺少锚点时降级为未判定,并说明原因', () => {
    const index = createProfileOriginIndex({}, readerFor({}))
    expect(index.source.resolved).toBe(false)
    expect(index.source.reason).toContain('ctx.baseUrl')
    expect(index.originOf('@deepseek-ai/dsh-session')).toBe('unknown')
  })

  it('清单读不出来时降级为未判定', () => {
    const dir = join('D:', 'DSH', 'home', 'profiles', 'web')
    const index = createProfileOriginIndex(
      { baseUrl: pathToFileURL(dir).href + '/' },
      readerFor({}),
    )
    expect(index.source.resolved).toBe(false)
    expect(index.originOf('@deepseek-ai/dsh-session')).toBe('unknown')
  })
})
