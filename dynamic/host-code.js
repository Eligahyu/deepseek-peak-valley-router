/**
 * 动态插件安装方式(推荐试用)。
 *
 * 把下方 HOST_CODE 的完整内容粘贴到对话中 cordis_define 工具的 code.host 参数
 * (plugin.kind 选 new 或 existing 均可),然后 cordis_run 激活。
 *
 * 与 lib/index.js(组合安装版)行为一致,差异仅在运行载体与宿主 API:
 *   - 动态版:使用沙箱提供的 harness.defineTool / harness.registerTool,并额外
 *     暴露 harness.handle('peak-valley-status') 供 Client UI 查询;
 *   - 组合版:从 @deepseek-ai/dsh-tools 导入 defineTool 后 ctx.tools.register,
 *     状态查询通过对话级工具 peakvalley_status 完成(无 host 通道)。
 */
export const HOST_CODE = `
return {
  name: 'deepseek-peak-valley-router',
  inject: ['tools'],
  apply(ctx) {
    // DeepSeek 官方峰谷定价(2026-08-17 生效)按北京时间定义:
    // 高峰 09:00-12:00 与 14:00-18:00(价格为低谷两倍),其余时段空闲。
    // 参考时区常量:无论机器在哪个时区/是否夏令时,都先换算到该时区再判断。
    const REFERENCE_TIME_ZONE = 'Asia/Shanghai'
    const FALLBACK_OFFSET_MS = 8 * 60 * 60 * 1000 // Asia/Shanghai = UTC+8,无夏令时
    const FLASH = 'deepseek-v4-flash'
    const PRO = 'deepseek-v4-pro'
    const DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek']
    const DEFAULT_MODEL_NS = 'agent-default-model'

    const log = (level, message) => {
      const fn = ctx.logger?.[level] ?? console[level] ?? console.log
      fn(message)
    }

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: REFERENCE_TIME_ZONE,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    })

    // 参考时区墙钟时间 { year, month, day, hour, minute }。绝不抛错:
    // Intl 不可用时回退 UTC+8(Asia/Shanghai 无夏令时)。
    function referenceNow() {
      try {
        const parts = formatter.formatToParts(new Date())
        const get = (type) => Number((parts.find(p => p.type === type) || {}).value || 0)
        return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute') }
      } catch {
        const d = new Date(Date.now() + FALLBACK_OFFSET_MS)
        return {
          year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(),
          hour: d.getUTCHours(), minute: d.getUTCMinutes(),
        }
      }
    }

    function isPeak(now) {
      return (now.hour >= 9 && now.hour < 12) || (now.hour >= 14 && now.hour < 18)
    }

    function windowState() {
      const now = referenceNow()
      const peak = isPeak(now)
      const pad = (n) => String(n).padStart(2, '0')
      return {
        peak,
        target: peak ? FLASH : PRO,
        timeZone: REFERENCE_TIME_ZONE,
        beijing: now.year + '-' + pad(now.month) + '-' + pad(now.day) + ' ' + pad(now.hour) + ':' + pad(now.minute) + ' ' + REFERENCE_TIME_ZONE,
      }
    }

    // 替换模型;切到 flash 时丢弃 reasoningEffort(flash 可能仅支持 off)。
    function withModel(config, model) {
      const replacement = { ...config, model }
      if (model === FLASH && replacement.reasoningEffort !== undefined) {
        delete replacement.reasoningEffort
      }
      return replacement
    }

    // 用户显式选择:界面模型选择器保存默认模型时,selectModel RPC 会把选择写入
    // agent-default-model 设置 → 触发 settings/updated 事件。记录后即尊重该选择。
    let userPicked = undefined

    // 启动兜底改为"首次请求时懒加载"(agent-default-model 与插件并行挂载,
    // apply 时刻可能未就绪,一次性 ctx.get 存在竞态)。首次路由请求时若默认
    // 模型已是 pro(非出厂默认 flash),视为用户先前显式选择。
    let fallbackChecked = false
    function ensureStartupFallback() {
      if (fallbackChecked || userPicked !== undefined) return
      fallbackChecked = true
      const adm = ctx.get('agentDefaultModel')
      if (adm === undefined) return
      const current = typeof adm.currentSelection === 'function' ? adm.currentSelection() : undefined
      if (current !== undefined && typeof current.provider === 'string' && current.model === PRO) {
        userPicked = { provider: current.provider, model: current.model }
      }
    }

    ctx.on('settings/updated', (ns, next) => {
      if (String(ns) !== DEFAULT_MODEL_NS) return
      if (typeof next !== 'object' || next === null) return
      const provider = next.provider
      const model = next.model
      if (typeof provider !== 'string' || typeof model !== 'string') return
      userPicked = { provider, model }
      log('info', 'peak-valley: 检测到用户显式模型选择 ' + provider + '/' + model + ',后续请求尊重该选择(不再自动切换)')
    })

    let lastState = null

    // agent/request 瀑布:next() 产出冻结的 LlmCallConfig,返回替换对象即切换模型,
    // 切换会被记录进 request/header。规则:非 DeepSeek 路由或非 V4 双模型不动;
    // 用户显式选择优先(同一 provider 直接路由到所选模型);其余按峰谷自动路由。
    ctx.on('agent/request', async (_payload, next) => {
      ensureStartupFallback()
      const config = await next()
      if (!DEEPSEEK_PROVIDERS.includes(config.provider)) return config
      if (config.model !== FLASH && config.model !== PRO) return config

      // 用户显式选择优先:同一 provider 下直接路由到用户选择的模型,
      // 请求当前配置(会话/子代理冻结值)是什么都尊重用户选择。
      if (userPicked !== undefined && userPicked.provider === config.provider) {
        if (config.model === userPicked.model) return config
        log('info', 'peak-valley: 尊重用户显式选择 ' + userPicked.model + '(请求配置 ' + config.model + ')')
        return withModel(config, userPicked.model)
      }

      const state = windowState()
      if (state.peak && config.model === FLASH) return config
      if (!state.peak && config.model === PRO) return config

      const label = state.peak ? '高峰' : '空闲'
      if (lastState !== label) {
        lastState = label
        log('info', 'peak-valley: 进入' + label + '时段(参考时区 ' + state.beijing + '),DeepSeek 模型路由 -> ' + state.target)
      }
      log('info', 'peak-valley: ' + config.model + ' -> ' + state.target + ' (' + label + ', 参考时区 ' + state.beijing + ')')
      return withModel(config, state.target)
    })

    function statusSnapshot() {
      const state = windowState()
      return {
        peak: state.peak,
        window: state.peak ? '09:00-12:00 / 14:00-18:00' : '其余时段',
        timeZone: state.timeZone,
        beijing: state.beijing,
        targetModel: state.target,
        mode: userPicked !== undefined ? 'respect' : 'auto',
        userPicked: userPicked !== undefined
          ? { provider: userPicked.provider, model: userPicked.model }
          : null,
      }
    }

    // 供后续 Client UI 查询当前识别结果(动态版专属;组合版用 peakvalley_status 工具)。
    harness.handle('peak-valley-status', () => statusSnapshot())

    // 对话级工具:查询当前峰谷识别与路由模式。
    harness.registerTool(ctx, harness.defineTool({
      name: 'peakvalley_status',
      description: '查询 DeepSeek 峰谷定价路由插件的当前状态:当前时段(高峰/空闲)、参考时区时间、自动目标模型、路由模式(auto 自动 / respect 尊重用户选择)、用户显式选择的模型(如有)。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        return statusSnapshot()
      },
    }))

    // 对话级工具:恢复自动路由(清除内存中的用户选择记录,直到用户再次在界面选择模型)。
    harness.registerTool(ctx, harness.defineTool({
      name: 'peakvalley_reset',
      description: '恢复自动峰谷路由:清除本插件记录的用户显式模型选择,DeepSeek 请求重新按当前时段自动选择 deepseek-v4-flash(高峰)/ deepseek-v4-pro(空闲)。用户在模型选择器里再次选择模型后,该选择会重新被尊重。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render(_args, value) {
          return [{ type: 'text', text: JSON.stringify(value, null, 2) }]
        },
      },
      async execute() {
        const had = userPicked !== undefined
        userPicked = undefined
        const state = windowState()
        return {
          ok: true,
          reset: had,
          mode: 'auto',
          targetModel: state.target,
          timeZone: state.timeZone,
          message: had ? '已清除用户选择记录,恢复自动峰谷路由' : '本就处于自动路由模式',
        }
      },
    }))
  },
}
`
