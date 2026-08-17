# deepseek-peak-valley-router

DeepSeek Harness 的**峰谷定价自动模型路由**插件:自动识别 DeepSeek API 当前处于高峰还是空闲时段,并据此自动选择模型——**高峰时段用便宜的 `deepseek-v4-flash` 省钱,空闲时段用更强的 `deepseek-v4-pro` 提质量**。你显式选择的模型始终优先,插件绝不剥夺你的选择权。

> 背景:DeepSeek 自 2026-08-17 起对 V4 系列 API 实行**峰谷定价**——高峰时段价格为空闲时段的 2 倍。官方高峰时段按**北京时间**定义为 `09:00-12:00` 与 `14:00-18:00`,其余为空闲时段。本插件据此自动调度,无需手动换模型。

## 功能

- **自动识别峰谷**:参考时区(默认 `Asia/Shanghai`,可配置)换算任意系统时区/夏令时下的当前时刻,判定高峰/空闲
- **自动路由**:高峰 → `deepseek-v4-flash`;空闲 → `deepseek-v4-pro`
- **用户选择优先**:你在模型选择器里显式选择的模型会被尊重,插件不再干预(通过监听 `agent-default-model` 设置的变更事件识别)
- **不越界**:非 DeepSeek 官方 provider、非这两个 V4 型号的请求一律不动
- **可审计**:每次切换都是 `agent/request` 瀑布的正式返回,记录进会话 `request/header` 事件,不是静默漂移
- **对话级工具**:
  - `peakvalley_status` — 查询当前时段、参考时区时间、目标模型、路由模式(auto / respect)、你显式选择的模型
  - `peakvalley_reset` — 恢复自动路由(清除内存中的用户选择记录,直到你再次在界面选模型)
- **边界处理**:从 pro 切到 flash 时自动丢弃 `reasoningEffort`(flash 可能仅支持 `off`),避免请求被拒绝

## 时段规则(官方)

| 时段 | 北京时间 | 定价 | 自动路由 |
| --- | --- | --- | --- |
| 高峰 | 09:00–12:00、14:00–18:00 | 全价(空闲的 2 倍) | `deepseek-v4-flash` |
| 空闲 | 其余时间 | 半价 | `deepseek-v4-pro` |

> 价格以 DeepSeek 官方公告为准,见文末参考链接。若官方调整时段,修改 `lib/timezone.js` 中的 `PEAK_WINDOWS` 即可。

## 安装

### 方式 A:动态插件(推荐试用,无需重启)

在 Harness 对话里用 `cordis_define` 工具创建插件,把 [`dynamic/host-code.js`](dynamic/host-code.js) 中 `HOST_CODE` 的完整内容粘贴到 `code.host` 参数,然后 `cordis_run` 激活即可。

### 方式 B:组合插件(永久安装,需要重启)

1. 把本仓库复制到 profile 共享的 node_modules:

   ```sh
   cp -r deepseek-peak-valley-router ~/.dsh/profiles/node_modules/deepseek-peak-valley-router
   # Windows PowerShell:
   # Copy-Item -Recurse deepseek-peak-valley-router "$env:USERPROFILE\.dsh\profiles\node_modules\deepseek-peak-valley-router"
   ```

2. 在 profile 的补丁层注册(例如 `~/.dsh/profiles/web/cordis.patch.yml` 追加):

   ```yaml
   - insert:
       - id: deepseek-peak-valley-router
         name: deepseek-peak-valley-router
         # 可选配置:参考时区(默认 Asia/Shanghai)
         # config:
         #   timeZone: 'Asia/Shanghai'
   ```

3. 重启 `dsh web`(新增行需要重启进程才会被 Loader 加载)。

> 依赖:运行在 DeepSeek Harness 内,`@deepseek-ai/dsh-tools` 由宿主提供(见 package.json 的 peerDependencies)。

## 行为规则(优先级从高到低)

1. **用户显式选择的模型 —— 永远优先**。你在模型选择器里选的每个模型都会写入 `agent-default-model` 设置,插件监听该设置的变更事件;一旦检测到,就只尊重它、不再自动切换。插件启动时若默认模型已是 pro(非出厂默认 flash),也会视为你的历史选择。
2. **自动路由(默认)**。未检测到显式选择时,按参考时区自动切换。
3. **不越界**。非 DeepSeek provider 或非 V4 双型号的请求原样放行。

## 工作原理

- **时区换算**:`lib/timezone.js` 用 `Intl.DateTimeFormat`(IANA 时区,`hourCycle: 'h23'`)把机器墙钟时间换算到参考时区,任何系统时区/夏令时下都正确;Intl 不可用时回退 `UTC+8` 偏移(Asia/Shanghai 无夏令时)。
- **路由缝**:挂接 `agent/request` 瀑布事件——`next()` 产出冻结的 `LlmCallConfig`,返回替换对象即完成切换,循环会把切换记录进 `request/header`。
- **选择权**:用户显式选择由 Harness 自身的会话模型选择机制(`installModelSelection`)保证优先;插件只在没有用户选择时做自动路由,且自身也带 respect 检查,双保险。

> 已知运行时说明:插件激活之前就已创建的会话,其模型由会话自身的"选择冻结"机制主导——你手动选模型立即生效且插件尊重;自动路由在下次页面刷新/重连(agent 重建)后对该会话生效,对新会话和所有子代理立即生效。这是 Harness 模型路由架构(冻结配置 + 会话选择优先)的既定行为。

## 验证

- 运行测试:`npm test`(Node ≥ 20,`node --test`)
- 启动后看日志:进入高峰/空闲时打印 `peak-valley: 进入高峰时段(参考时区 ...),DeepSeek 模型路由 -> deepseek-v4-flash`;每次切换打印 `peak-valley: deepseek-v4-flash -> deepseek-v4-pro (...)`
- 对话中调用 `peakvalley_status` 查看当前状态
- 会话日志的 `request/header` 事件记录每个请求实际使用的模型

## 目录结构

```
deepseek-peak-valley-router/
├── lib/
│   ├── index.js          # 组合安装版插件(ESM,配置文件读 config.timeZone)
│   └── timezone.js       # 纯逻辑:时区换算 + 峰谷判定(零依赖,可独立测试)
├── dynamic/
│   └── host-code.js      # 动态安装版(cordis_define code.host 原文)
├── test/
│   └── timezone.test.js  # node --test 用例(时区换算、边界时刻、跨午夜)
├── package.json
├── README.md
└── LICENSE
```

## 免责声明

- 峰谷时段、价格以 [DeepSeek 官方公告](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) 为准;本插件按公告实现,不保证与未来价格政策一致。
- 自动切换模型可能改变回答质量/行为;重要任务请留意实际使用的模型(会话 `request/header` 可查)。
- 本插件与 DeepSeek 官方无任何隶属关系,非官方作品。

## 参考

- [DeepSeek API 模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [DeepSeek-V4 系列 API 正式调价:首创峰谷计费(TechWeb)](https://www.techweb.com.cn/it/2026-08-17/2978269.shtml)
- [DeepSeek API 启用峰谷定价(通信世界)](http://www.cww.net.cn/article?id=612617)

## License

[MIT](LICENSE)
