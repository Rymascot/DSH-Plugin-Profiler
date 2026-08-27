import type { ProfilerCollector } from '../core/collector.js'
import type { ProfilerSnapshot } from '../core/types.js'
import { PROFILER_SERVICE } from '../typert-descriptor.js'

export interface ProfilerGatewayBinding {
  readonly service: ProfilerGateway
  readonly serviceKey: typeof PROFILER_SERVICE
  readonly namespace: typeof PROFILER_SERVICE
}

/**
 * 通过严格的 ./typert 描述暴露 Cordis 服务。
 *
 * Cordis 获取服务时可能返回代理对象，因此这里不能使用 JavaScript 私有字段。
 */
export class ProfilerGateway {
  readonly typertRemote: ProfilerGatewayBinding
  readonly collector: ProfilerCollector

  constructor(collector: ProfilerCollector) {
    this.collector = collector
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: PROFILER_SERVICE,
      namespace: PROFILER_SERVICE,
    })
  }

  snapshot(): ProfilerSnapshot {
    return this.collector.snapshot()
  }
}