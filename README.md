# DSH 插件性能分析器

DSH 插件性能分析器是一款面向 DeepSeek Harness 的插件生命周期性能分析与可视化工具，用于帮助开发者判断性能问题来自插件自身初始化，还是上游依赖阻塞。

## 功能概览

- 在主机端采集 Cordis 插件生命周期事件；
- 分别统计依赖等待时间和插件激活时间；
- 通过 `pluginProfiler/snapshot` 提供带严格校验的 Typert 远程查询接口；
- 在“设置 → 插件 → 性能”中展示分析结果；
- 展示样本数量、完整耗时数量、中位数、P95、失败数量和诊断数量；
- 支持插件重载代次、截断样本和部分覆盖状态。

## 当前状态

当前版本已经具备主机端采集、远程快照接口和浏览器性能页签，可以安装到 DSH Web 配置档中使用。

兼容目标：DSH `0.1.1-rc.2`。

## 开发环境

### 推荐开发软件

本项目是纯 TypeScript 和 React 项目，推荐使用 WebStorm。

如果已经安装 IntelliJ IDEA Ultimate，也可以直接打开项目进行开发；社区版 IntelliJ IDEA 对前端开发的支持相对有限。

### 环境要求

- Node.js `22.19.0` 或更高兼容版本；
- pnpm `11.7.0` 或兼容版本；
- DeepSeek Harness `0.1.1-rc.2`。

## 安装依赖

在项目目录中执行：

```powershell
cd D:\DSH\Plugin\DSH-Plugin-Profiler
pnpm install
```

## 检查项目

```powershell
pnpm run check
```

完整检查会依次执行：

1. TypeScript 类型检查；
2. 单元测试；
3. 主机端代码构建；
4. 浏览器插件包构建；
5. DSH 插件产物契约检查。

## 单独构建

```powershell
pnpm run build
```

构建完成后，主要产物位于 `lib` 目录：

- `lib/index.js`：主机端插件入口；
- `lib/typert.host.js`：主机端 Typert 描述；
- `lib/typert.remote-client.js`：浏览器端远程调用描述；
- `lib/client.js`：DSH 浏览器插件包。

## 安装到 DSH

如果终端能够直接使用 `dsh` 命令，请执行：

```powershell
pnpm run build
dsh plugin --profile web add .
```

如果当前电脑没有把 `dsh` 加入环境变量，可以使用本机 DSH 命令行入口：

```powershell
pnpm run build
node D:\DSH\app\apps\cli\lib\bin.js plugin --profile web add .
```

以上两种安装方式二选一即可。

## 启动方式

安装完成后，正常启动或重启 DSH Web 配置档即可。插件会由 DSH 自动加载，不需要单独打开一个 PowerShell 窗口常驻运行。

PowerShell 只在以下情况需要使用：

- 第一次安装依赖；
- 重新构建插件；
- 将新版本重新安装到 DSH；
- 运行测试或开发检查。

启动 DSH 后，可在“设置 → 插件 → 性能”中查看采集结果。

## 数据覆盖范围

当前快照属于“部分覆盖”，内部标记为 `partial`。普通插件包无法回溯自身加载前已经发生的事件，因此暂不包含：

- 性能分析器挂载前的生命周期事件；
- 模块解析和导入耗时；
- 整个配置档的完整冷启动耗时；
- 启动关键路径；
- 没有加载器条目的 Cordis Fiber。

缺少起点或终点的样本会明确显示为截断观测，不会伪造为 `0 ms`。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `src/core` | 生命周期状态机、采集器和公共数据类型 |
| `src/adapters` | DSH 与 Cordis 内部生命周期事件适配 |
| `src/host` | 主机端远程快照服务 |
| `src/wire` | 跨主机端和浏览器端的快照校验契约 |
| `src/client` | React 性能页签、中文和英文文案、样式 |
| `tests` | 采集、适配、远程契约和客户端测试 |
| `cordis.patch.yml` | 安装到 DSH 配置档时使用的插件补丁 |

## 注意事项

不要再手动向同一个 DSH 配置档的 `cordis.patch.yml` 插入 `plugin-profiler`。通过插件命令安装后再次手动插入，会产生重复的加载器条目标识。

升级 DSH 后，应优先重新验证 `src/adapters/cordis-internal.ts`，因为该文件负责适配与版本相关的 Cordis 内部状态和事件。
