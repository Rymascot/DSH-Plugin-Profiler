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

## 开发

在插件目录执行：

```powershell
cd D:\DSH\Plugin\DSH-Plugin-Profiler
pnpm run check