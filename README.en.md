# deepseek-peak-valley-router

**English** | [简体中文](README.md)

A **peak/valley pricing auto model router** for DeepSeek Harness: it detects whether the DeepSeek API is currently in its peak or off-peak pricing window and automatically picks the model accordingly — **use the cheap `deepseek-v4-flash` during peak hours to save money, and the stronger `deepseek-v4-pro` during off-peak hours for better quality**. A model you explicitly select is always respected; the plugin never takes away your choice.

> Background: since 2026-08-17 DeepSeek prices its V4 API with **peak/valley pricing** — peak hours cost 2× the off-peak price. The official peak windows are defined in **Beijing time** as `09:00-12:00` and `14:00-18:00`; everything else is off-peak. This plugin schedules the model for you automatically.

## Features

- **Automatic peak/valley detection**: converts the machine's wall clock to a reference time zone (default `Asia/Shanghai`, configurable) so detection is correct under any system time zone / DST
- **Automatic routing**: peak → `deepseek-v4-flash`; off-peak → `deepseek-v4-pro`
- **Your explicit choice wins**: any model you pick in the model selector is **routed to directly** (same provider — regardless of what the request config currently says), detected via changes to the `agent-default-model` setting
- **Never overreaches**: requests on non-DeepSeek providers or non-V4 models are passed through untouched
- **Auditable**: every switch is a proper return from the `agent/request` waterfall and is recorded in the session's `request/header` event — no silent drift
- **Chat tools**:
  - `peakvalley_status` — current window, reference-time clock, target model, routing mode (auto / respect), and your explicit selection
  - `peakvalley_reset` — restore automatic routing (clears the in-memory user-selection record until you pick a model again in the UI)
- **Robustness**: an invalid `timeZone` config falls back to the default zone with a one-time warning — requests never fail; the startup fallback is lazily loaded on the first request, independent of host service mount order
- **Edge handling**: when switching pro → flash, `reasoningEffort` is dropped (flash may only support `off`) so the request is never rejected

## Official windows

| Window | Beijing time | Pricing | Auto route |
| --- | --- | --- | --- |
| Peak | 09:00–12:00, 14:00–18:00 | Full price (2× off-peak) | `deepseek-v4-flash` |
| Off-peak | all other times | Half price | `deepseek-v4-pro` |

> Prices are subject to DeepSeek's official announcements (see links at the bottom). If the official windows change, edit `PEAK_WINDOWS` in `lib/timezone.js`.

## Installation

### Option A: Dynamic plugin (recommended to try, no restart)

In a Harness conversation, create the plugin with the `cordis_define` tool, paste the full `HOST_CODE` from [`dynamic/host-code.js`](dynamic/host-code.js) into the `code.host` parameter, then activate it with `cordis_run`.

### Option B: Composition plugin (official bundle install, permanent, requires restart)

This package is a standard DSH bundle (declares `dsh.bundle` + `cordis.patch.yml`), so use the official install path:

```sh
# local checkout
dsh plugin --profile web add ./deepseek-peak-valley-router

# or from GitHub
dsh plugin --profile web add github:Eligahyu/deepseek-peak-valley-router

# once published to npm (recommended — no build authorization needed):
dsh plugin --profile web add deepseek-peak-valley-router

dsh --profile web   # restart to load
```

Optional time zone config (default `Asia/Shanghai`): override in your profile's own patch layer:

```yaml
# append to ~/.dsh/profiles/web/cordis.patch.yml
- id: deepseek-peak-valley-router
  config:
    timeZone: 'America/New_York'
```

> Dependencies: runs inside DeepSeek Harness; `@deepseek-ai/dsh-tools` is provided by the host (see peerDependencies in package.json) and resolves through the launcher-maintained flat module fallback — nothing to install manually.

## Behavior rules (priority, highest first)

1. **A model you explicitly selected — always wins.** Every model you pick in the selector is written to the `agent-default-model` setting; the plugin listens for that change and then **routes directly to your chosen model** for every request on that provider — even when the request config carries a frozen value from a session/subagent. If the default model is already pro (not the factory-default flash) on the first request after startup, it is treated as your historical choice.
2. **Automatic routing (default).** When no explicit selection is detected, switch by reference time zone.
3. **Never overreach.** Requests on non-DeepSeek providers or non-V4 models pass through unchanged.

## How it works

- **Time zone conversion**: `lib/timezone.js` uses `Intl.DateTimeFormat` (IANA time zones, `hourCycle: 'h23'`) to convert the machine's wall clock to the reference zone — correct under any system time zone / DST; an invalid time zone falls back to the default zone, and to the `UTC+8` offset (Asia/Shanghai has no DST) when Intl is unavailable. The request path never throws.
- **Routing seam**: hooks the `agent/request` waterfall — `next()` yields the frozen `LlmCallConfig`; returning a replacement switches the model, and the loop records the switch in `request/header`.
- **Your choice**: Harness's own session model-selection mechanism (`installModelSelection`) already guarantees that an explicit user selection wins; the plugin also actively routes to your selection in its own respect check as a second layer.

> Runtime note: for sessions created before the plugin was activated, the model is governed by the session's own selection-freeze mechanism — picking a model in the UI takes effect immediately and is respected; automatic routing takes effect for such a session after the next page refresh / reconnect (agent re-creation), and immediately for new sessions and all subagents. This is the intended behavior of Harness's model-routing architecture (frozen config + session selection priority).

> Variant difference: the dynamic variant additionally exposes the `harness.handle('peak-valley-status')` host method (for a future Client UI); the composed variant has no host channel and exposes status through the `peakvalley_status` chat tool. Everything else behaves identically.

## Verification

- Run the tests: `npm test` (Node ≥ 20, `node --test`, 21 cases: time-zone logic + routing behavior)
- Watch the logs: entering peak/off-peak prints `peak-valley: 进入高峰时段(...),DeepSeek 模型路由 -> deepseek-v4-flash`; each switch prints `peak-valley: deepseek-v4-flash -> deepseek-v4-pro (...)`
- Call `peakvalley_status` in a conversation to see the current state
- The session's `request/header` events record the model actually used by every request

## Repository layout

```
deepseek-peak-valley-router/
├── .github/workflows/test.yml # CI: node --test on Node 20/22/24
├── cordis.patch.yml           # bundle patch (official dsh plugin add entry)
├── lib/
│   ├── index.js          # composition plugin (ESM, reads config.timeZone)
│   └── timezone.js       # pure logic: time-zone conversion + peak/valley check (zero deps)
├── dynamic/
│   └── host-code.js      # dynamic plugin variant (cordis_define code.host source)
├── test/
│   ├── timezone.test.js  # conversion, boundaries, cross-midnight
│   └── router.test.js    # routing behavior: auto route / user pick / tz fallback / tools
├── package.json
├── CHANGELOG.md
├── README.md
├── README.en.md
└── LICENSE
```

## Disclaimer

- Peak/valley windows and prices are subject to the [official DeepSeek announcements](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/); this plugin implements them as announced and makes no guarantee about future pricing policy.
- Automatic model switching may change answer quality/behavior; for important tasks, check the model actually used (see `request/header` in the session log).
- This plugin is not affiliated with or endorsed by DeepSeek.

## References

- [DeepSeek API models & pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
- [DeepSeek-V4 API repricing: first peak/valley billing (TechWeb)](https://www.techweb.com.cn/it/2026-08-17/2978269.shtml)
- [DeepSeek API enables peak/valley pricing (CWW)](http://www.cww.net.cn/article?id=612617)

## License

[MIT](LICENSE)
