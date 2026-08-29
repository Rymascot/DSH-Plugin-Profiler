# DSH 插件性能分析器

用于记录 DSH 插件挂载后的 Cordis 生命周期事件，并在设置页面展示插件启动性能。

## 功能

- 记录插件依赖等待时间
- 记录插件激活耗时
- 区分成功、失败、进行中和未完成状态
- 显示中位数和 P95 激活耗时
- 支持按插件名称搜索
- 展示诊断信息
- 通过 Host Remote 接口读取性能快照

## 当前覆盖范围

当前版本属于部分覆盖模式：

- 只记录 Profiler 加载之后发生的事件
- 不包含 Profiler 加载之前的启动事件
- 不包含模块解析和导入耗时
- 不包含没有 Loader 条目的 Fiber
- 不代表整个 Profile 的冷启动耗时
- 暂不计算完整关键路径

## 面向普通用户

### 适合哪些用户？

本插件面向希望了解 DSH 插件启动情况的普通用户，包括：

- 想查看哪些插件启动较慢的用户
- 想排查插件启动失败或卡顿问题的用户
- 想比较插件依赖等待时间和自身激活耗时的用户
- 想了解当前 DSH 插件运行状态的用户

普通用户不需要了解 TypeScript、Cordis 或 Remote 接口，也不需要修改插件代码。

### 如何打开？

启动 DSH 后，依次进入：

```text
设置 → 插件 → 性能
```

进入“插件启动性能”页面后，插件会自动读取当前 Host 的性能数据。

### 如何确认插件已经安装？

如果能够看到“插件启动性能”页签和卡片，说明本插件已经被 DSH 识别并成功加载。

如果完全看不到该页签，才需要检查插件是否安装，以及当前 Profile 是否已经加载本插件。

### 页面可以看到什么？

- 当前记录到的插件数量
- 插件依赖等待时间和激活耗时
- 插件启动成功、失败、进行中或提前结束的状态
- 中位数和 P95 激活耗时
- Host 运行时诊断信息
- 按插件名称搜索和筛选的结果

### “部分覆盖”是什么意思？

“部分覆盖”表示 Profiler 只能统计自身挂载之后发生的生命周期事件。页面数据适合定位插件之间的相对性能差异，但不能当作整个 DSH 的完整冷启动时间。

### 无法读取性能数据怎么办？

如果页面显示“暂时无法读取性能数据”，说明插件前端已经加载，但暂时没有从 DSH Host 端取得性能快照。请依次尝试：

1. 完全关闭并重新启动 DSH
2. 在浏览器中按 `Ctrl + Shift + R` 强制刷新
3. 返回“设置 → 插件 → 性能”并点击“重试”
4. 如果仍然失败，查看启动 DSH 的 PowerShell 窗口，并将其中的错误信息提供给开发者

### 是否需要安装其他插件？

通常不需要额外安装普通功能插件。本插件依赖 DSH 自带的 Host、Remote 和 Typert 基础运行环境。如果“插件启动性能”页面能够显示，就说明本插件本身已经安装成功；读取失败通常发生在 Host Remote 注册或调用阶段。

## 开发

在插件目录执行：

```powershell
cd D:\DSH\Plugin\DSH-Plugin-Profiler
pnpm run check
```

`check` 命令会依次执行：

1. TypeScript 类型检查
2. 单元测试
3. Host 和 Client 构建
4. 构建产物验证

也可以按需要单独执行：

```powershell
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run verify:build
```

### 启动 DSH

构建完成后，在 DSH 项目目录启动 Web 界面：

```powershell
cd D:\DSH\app
pnpm dsh web
```

修改源码后，需要重新构建并完全重启 DSH。浏览器仍显示旧界面时，请按 `Ctrl + Shift + R` 强制刷新。

## 工作方式

插件分为 Host 和 Client 两部分：

- Host 端监听 Cordis 生命周期事件并生成性能快照
- Typert 描述声明 `pluginProfiler/snapshot` Remote 接口
- Client 端读取快照，并在“设置 → 插件 → 性能”中展示结果

## 项目结构

```text
src/
├─ adapters/                 Cordis 生命周期适配
├─ client/                   设置页面和浏览器端入口
├─ core/                     性能采集器与状态机
├─ host/                     Host Remote 网关
├─ wire/                     数据结构和边界校验
├─ index.ts                  Host 插件入口
├─ typert.host.ts            Host Typert 描述
└─ typert.remote-client.ts   Client Remote 描述
```

## 当前状态

本项目仍处于开发阶段。当前数据适合定位插件之间的相对启动性能差异，但暂不能替代完整的 DSH 冷启动分析。
