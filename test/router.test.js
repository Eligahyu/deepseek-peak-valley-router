/**
 * 路由行为测试:用 stub ctx + stub @deepseek-ai/dsh-tools 加载真实插件代码,
 * 覆盖自动路由、用户选择优先、时区容错、启动兜底、工具注册等场景。
 *
 * 运行:npm test(node --test,零依赖)。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const PEAK_BEIJING_11 = '2026-08-17T03:00:00Z'   // 11:00 Asia/Shanghai(高峰)
const OFFPEAK_BEIJING_22 = '2026-08-17T14:00:00Z' // 22:00 Asia/Shanghai(空闲)

const RealDate = Date

/** 加载真实插件:临时目录 + stub dsh-tools,返回 { plugin, apply }。 */
async function loadPlugin() {
  const tmp = mkdtempSync(join(tmpdir(), 'pvr-load-'))
  try {
    const modules = join(tmp, 'node_modules', '@deepseek-ai', 'dsh-tools')
    mkdirSync(modules, { recursive: true })
    writeFileSync(join(modules, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tools', version: '0.0.0', type: 'module', main: 'index.js' }))
    writeFileSync(join(modules, 'index.js'), 'export function defineTool(o) { return o }\n')
    cpSync(join(REPO_ROOT, 'lib'), join(tmp, 'lib'), { recursive: true })
    const mod = await import(pathToFileURL(join(tmp, 'lib', 'index.js')).href)
    return { plugin: mod.default, cleanup: () => rmSync(tmp, { recursive: true, force: true }) }
  } catch (error) {
    rmSync(tmp, { recursive: true, force: true })
    throw error
  }
}

/** 固定时钟(UTC 瞬时),返回恢复函数。 */
function freezeClock(iso) {
  const fakeNow = new RealDate(iso).getTime()
  globalThis.Date = class extends RealDate {
    constructor(...args) { args.length ? super(...args) : super(fakeNow) }
    static now() { return fakeNow }
  }
  return () => { globalThis.Date = RealDate }
}

/** 构造 fake ctx 并 apply 插件;返回 { listeners, tools, ctx }。 */
function makeCtx(plugin, config = {}, options = {}) {
  const listeners = {}
  const tools = []
  let getReturns = options.agentDefaultModel
  const ctx = {
    on(event, fn) { (listeners[event] ??= []).push(fn); return () => {} },
    get() { return getReturns },
    setAgentDefaultModel(value) { getReturns = value },
    tools: { register: (d) => { tools.push(d); return () => {} } },
    logger: options.logger ?? { info() {}, warn() {}, error() {} },
  }
  plugin.apply(ctx, config)
  return { ctx, listeners, tools }
}

/** 发起一次 agent/request,返回最终 LlmCallConfig。 */
function request(listeners, { provider = 'deepseek-official', model = FLASH, reasoningEffort = 'max' } = {}) {
  const next = () => Promise.resolve({ provider, model, reasoningEffort })
  return listeners['agent/request'][0]({ agent: {}, turn: 1, step: 1, signal: {} }, next)
}

/** 模拟用户通过模型选择器保存默认模型(settings/updated)。 */
function pickModel(listeners, model) {
  listeners['settings/updated'].forEach((fn) => fn('agent-default-model', { provider: 'deepseek-official', model }, {}, 'update'))
}

test('空闲时段自动路由:flash → pro', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(OFFPEAK_BEIJING_22)
  try {
    const { listeners } = makeCtx(plugin)
    const out = await request(listeners, { model: FLASH })
    assert.equal(out.model, PRO)
  } finally { restore(); cleanup() }
})

test('高峰时段自动路由:pro → flash', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const { listeners } = makeCtx(plugin)
    const out = await request(listeners, { model: PRO })
    assert.equal(out.model, FLASH)
  } finally { restore(); cleanup() }
})

test('目标已是当前时段模型时保持不变', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const { listeners } = makeCtx(plugin)
    const out = await request(listeners, { model: FLASH })
    assert.equal(out.model, FLASH)
  } finally { restore(); cleanup() }
})

test('用户显式选择优先:高峰 + 选 pro + 请求配置 flash → 路由到 pro', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const { listeners } = makeCtx(plugin)
    pickModel(listeners, PRO)
    const out = await request(listeners, { model: FLASH })
    assert.equal(out.model, PRO, '必须尊重用户显式选择,而非保留冻结的 flash')
  } finally { restore(); cleanup() }
})

test('用户显式选择优先:空闲 + 选 flash + 请求配置 pro → 路由到 flash', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(OFFPEAK_BEIJING_22)
  try {
    const { listeners } = makeCtx(plugin)
    pickModel(listeners, FLASH)
    const out = await request(listeners, { model: PRO })
    assert.equal(out.model, FLASH, '用户显式选的 flash 在空闲时段也优先')
  } finally { restore(); cleanup() }
})

test('用户显式选择优先:请求配置已匹配时原样返回(含 reasoningEffort)', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const { listeners } = makeCtx(plugin)
    pickModel(listeners, PRO)
    const out = await request(listeners, { model: PRO, reasoningEffort: 'max' })
    assert.equal(out.model, PRO)
    assert.equal(out.reasoningEffort, 'max')
  } finally { restore(); cleanup() }
})

test('切到 flash 时丢弃 reasoningEffort', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const { listeners } = makeCtx(plugin)
    const out = await request(listeners, { model: PRO, reasoningEffort: 'max' })
    assert.equal(out.model, FLASH)
    assert.equal(out.reasoningEffort, undefined)
  } finally { restore(); cleanup() }
})

test('不越界:非 DeepSeek provider 的请求原样返回', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(OFFPEAK_BEIJING_22)
  try {
    const { listeners } = makeCtx(plugin)
    const out = await request(listeners, { provider: 'anthropic', model: 'claude-sonnet-4' })
    assert.equal(out.model, 'claude-sonnet-4')
  } finally { restore(); cleanup() }
})

test('不越界:非 V4 型号的 DeepSeek 请求原样返回', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(OFFPEAK_BEIJING_22)
  try {
    const { listeners } = makeCtx(plugin)
    const out = await request(listeners, { model: 'deepseek-v3' })
    assert.equal(out.model, 'deepseek-v3')
  } finally { restore(); cleanup() }
})

test('非法 timeZone 配置:不抛错,回退默认时区并告警', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const warns = []
    const { listeners } = makeCtx(plugin, { timeZone: 'Mars/Olympus' }, {
      logger: { info() {}, warn: (m) => warns.push(m), error() {} },
    })
    const out = await request(listeners, { model: PRO })
    assert.equal(out.model, FLASH, '回退默认时区后仍按北京时间高峰路由')
    assert.ok(warns.some((m) => m.includes('Mars/Olympus')), '应输出一次告警')
  } finally { restore(); cleanup() }
})

test('启动兜底:apply 时 agentDefaultModel 未就绪,首次请求时懒加载并尊重 pro 默认', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    // apply 时 ctx.get 返回 undefined(服务未挂载),之后才可用。
    const { ctx, listeners } = makeCtx(plugin, {}, { agentDefaultModel: undefined })
    ctx.setAgentDefaultModel({ currentSelection: () => ({ provider: 'deepseek-official', model: PRO }) })
    const out = await request(listeners, { model: FLASH })
    assert.equal(out.model, PRO, '默认模型为 pro 应视为用户先前选择,高峰也不切 flash')
  } finally { restore(); cleanup() }
})

test('peakvalley_reset 清除用户选择并恢复自动路由', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(PEAK_BEIJING_11)
  try {
    const { listeners, tools } = makeCtx(plugin)
    const names = tools.map((t) => t.name)
    assert.ok(names.includes('peakvalley_status'))
    assert.ok(names.includes('peakvalley_reset'))

    pickModel(listeners, PRO)
    const before = await request(listeners, { model: FLASH })
    assert.equal(before.model, PRO)

    const resetTool = tools.find((t) => t.name === 'peakvalley_reset')
    const resetResult = await resetTool.execute()
    assert.equal(resetResult.reset, true)
    assert.equal(resetResult.mode, 'auto')

    const after = await request(listeners, { model: FLASH })
    assert.equal(after.model, FLASH, '清除选择后恢复自动路由,高峰保留 flash')
  } finally { restore(); cleanup() }
})

test('peakvalley_status 反映时段、模式与用户选择', async () => {
  const { plugin, cleanup } = await loadPlugin()
  const restore = freezeClock(OFFPEAK_BEIJING_22)
  try {
    const { listeners, tools } = makeCtx(plugin)
    const statusTool = tools.find((t) => t.name === 'peakvalley_status')
    const status = await statusTool.execute()
    assert.equal(status.peak, false)
    assert.equal(status.targetModel, PRO)
    assert.equal(status.mode, 'auto')
    pickModel(listeners, FLASH)
    const status2 = await statusTool.execute()
    assert.equal(status2.mode, 'respect')
    assert.deepEqual(status2.userPicked, { provider: 'deepseek-official', model: FLASH })
  } finally { restore(); cleanup() }
})
