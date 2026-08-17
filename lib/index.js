/**
 * peak-valley-router — DeepSeek Harness 峰谷定价自动模型路由插件(组合安装版)。
 *
 * 行为规则(从高到低):
 *   1. 用户显式选择的模型(模型选择器保存的默认模型)→ 始终尊重,不干预;
 *   2. 自动路由(默认):参考时区处于高峰(默认 Asia/Shanghai 09:00-12:00、
 *      14:00-18:00)→ deepseek-v4-flash;空闲 → deepseek-v4-pro;
 *   3. 不越界:非 DeepSeek 官方 provider 或非这两个 V4 型号的请求一律不动。
 *
 * 安装方式见 README;本文件是 cordis 组合插件(profile 永久安装),
 * dynamic/host-code.js 是动态插件(cordis_define 粘贴)版本。
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { DEFAULT_TIME_ZONE, referenceNow, isPeakWindow } from './timezone.js'

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const DEEPSEEK_PROVIDERS = ['deepseek-official', 'deepseek']
const DEFAULT_MODEL_NS = 'agent-default-model'

/**
 * 组合插件配置(profile cordis.yml 的 config 段):
 *   timeZone: IANA 参考时区,默认 'Asia/Shanghai'。
 */
export default {
  name: 'peak-valley-router',
  inject: ['tools'],
  apply(ctx, config = {}) {
    const timeZone = typeof config.timeZone === 'string' && config.timeZone.length > 0
      ? config.timeZone
      : DEFAULT_TIME_ZONE

    function windowState() {
      const now = referenceNow(new Date(), timeZone)
      const peak = isPeakWindow(now)
      const pad = (n) => String(n).padStart(2, '0')
      return {
        peak,
        target: peak ? FLASH : PRO,
        timeZone,
        clock: `${now.year}-${pad(now.month)}-${pad(now.day)} ${pad(now.hour)}:${pad(now.minute)} ${timeZone}`,
      }
    }

    // 用户显式选择:模型选择器(selectModel RPC)会把选择写入 agent-default-model
    // 设置 → 触发 settings/updated 事件。记录后即尊重该选择。
    let userPicked = undefined

    // 启动兜底:若默认模型已是 pro(而非出厂默认 flash),视为用户先前显式选择。
    const adm = ctx.get('agentDefaultModel')
    if (adm !== undefined) {
      const current = adm.currentSelection()
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
      console.log('peak-valley: 检测到用户显式模型选择 ' + provider + '/' + model + ',后续请求尊重该选择(不再自动切换)')
    })

    let lastState = null

    // agent/request 瀑布:next() 产出冻结的 LlmCallConfig,返回替换对象即切换模型,
    // 切换会被记录进 request/header。规则见文件头。
    ctx.on('agent/request', async (_payload, next) => {
      const config = await next()
      if (!DEEPSEEK_PROVIDERS.includes(config.provider)) return config
      if (config.model !== FLASH && config.model !== PRO) return config

      if (userPicked !== undefined
        && userPicked.provider === config.provider
        && userPicked.model === config.model) {
        return config
      }

      const state = windowState()
      if (state.peak && config.model === FLASH) return config
      if (!state.peak && config.model === PRO) return config

      const replacement = { ...config, model: state.target }
      // flash 可能仅支持 reasoningEffort 'off',切到 flash 时丢弃 effort 落到适配器默认。
      if (state.target === FLASH && replacement.reasoningEffort !== undefined) {
        delete replacement.reasoningEffort
      }

      const label = state.peak ? '高峰' : '空闲'
      if (lastState !== label) {
        lastState = label
        console.log('peak-valley: 进入' + label + '时段(' + state.clock + '),DeepSeek 模型路由 -> ' + state.target)
      }
      console.log('peak-valley: ' + config.model + ' -> ' + state.target + ' (' + label + ', ' + state.clock + ')')
      return replacement
    })

    function statusSnapshot() {
      const state = windowState()
      return {
        peak: state.peak,
        window: state.peak ? '09:00-12:00 / 14:00-18:00' : '其余时段',
        timeZone: state.timeZone,
        clock: state.clock,
        targetModel: state.target,
        mode: userPicked !== undefined ? 'respect' : 'auto',
        userPicked: userPicked !== undefined
          ? { provider: userPicked.provider, model: userPicked.model }
          : null,
      }
    }

    // 对话级工具:查询当前峰谷识别与路由模式。
    ctx.tools.register(defineTool({
      name: 'peakvalley_status',
      description: '查询 DeepSeek 峰谷定价路由插件的当前状态:当前时段(高峰/空闲)、参考时区时间、自动目标模型、路由模式(auto 自动 / respect 尊重用户选择)、用户显式选择的模型(如有)。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      },
      async execute() {
        return statusSnapshot()
      },
    }))

    // 对话级工具:恢复自动路由(清除内存中的用户选择记录,直到用户再次在界面选择模型)。
    ctx.tools.register(defineTool({
      name: 'peakvalley_reset',
      description: '恢复自动峰谷路由:清除本插件记录的用户显式模型选择,DeepSeek 请求重新按当前时段自动选择 deepseek-v4-flash(高峰)/ deepseek-v4-pro(空闲)。用户在模型选择器里再次选择模型后,该选择会重新被尊重。',
      parameters: {},
      output: {
        schema: { type: 'json' },
        render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
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
