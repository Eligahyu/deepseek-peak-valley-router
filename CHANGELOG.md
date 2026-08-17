# Changelog

## 1.1.0 (2026-08-17)

### 修复
- **用户显式选择真正"路由到"所选模型**:此前 respect 逻辑只在请求配置恰好等于用户选择时才生效——当请求配置来自会话/子代理的冻结值(如高峰时段配置为 flash)时,用户选的 pro 会被无视。现在同一 provider 下直接路由到用户选择的模型。
- **非法 timeZone 配置不再打崩请求**:此前 `config.timeZone` 配错(如 `Mars/Olympus`)会让每次 `agent/request` 抛错,整个 DeepSeek 请求流水线失败。现在配置在 apply 时校验一次,无效则回退 `Asia/Shanghai` 并告警;`referenceNow()` 承诺在任何情况下都不抛错。
- **启动兜底消除加载竞态**:此前在 apply 时一次性 `ctx.get('agentDefaultModel')`,而该服务与插件并行挂载,顺序不定,兜底可能永久失效。现在改为首次路由请求时懒加载。
- **日志改用 `ctx.logger`**(缺失时回退 console,与动态版沙箱一致)。

### 新增
- **标准 DSH bundle**:新增 `dsh.bundle` 声明与 `cordis.patch.yml`,支持官方安装路径 `dsh plugin --profile web add ...`(本地 / git / npm)。
- **路由行为测试套件**:13 个场景(自动路由、用户选择优先、时区容错、启动兜底、工具行为、不越界),连同时区纯逻辑共 21 个用例。
- **CI**:`.github/workflows/test.yml`,Node 20/22/24 上自动运行。

### 文档
- README 安装方式更新为 `dsh plugin add`;目录结构修正(补 `cordis.patch.yml`、`test/router.test.js`、CI 等)。
- 明确双版本差异:动态版额外暴露 `harness.handle('peak-valley-status')` Host 通道,组合版通过 `peakvalley_status` 工具查询状态。

## 1.0.0 (2026-08-17)

- 首个发布:峰谷定价自动模型路由(组合安装版 + 动态插件版),时区感知峰谷判定,用户选择优先,对话级状态/重置工具。
