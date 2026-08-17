/**
 * 时区感知的峰谷判定纯逻辑(零依赖,可独立测试)。
 *
 * DeepSeek 官方峰谷定价按北京时间(Asia/Shanghai)定义,本模块把任意机器的
 * 墙钟时间换算到参考时区后再判定高峰/空闲,因此无论机器在哪个时区、是否
 * 实行夏令时,判定结果都正确。
 *
 * 健壮性约定:referenceNow() 绝不在请求路径抛错——非法/不受支持的时区先
 * 回退默认时区,再失败则回退 UTC+8 偏移;配置层的时区合法性由
 * isValidTimeZone() 校验,插件在 apply 时告警并回退。
 */

/** 默认参考时区:DeepSeek 官方定价使用的时区。 */
export const DEFAULT_TIME_ZONE = 'Asia/Shanghai'

/** Asia/Shanghai = UTC+8 且无夏令时;仅作为 Intl 不可用时的兜底偏移。 */
export const FALLBACK_OFFSET_MS = 8 * 60 * 60 * 1000

/**
 * 官方高峰时段(参考时区),end 不包含:
 * 09:00-12:00 与 14:00-18:00。
 */
export const PEAK_WINDOWS = [
  { start: { hour: 9, minute: 0 }, end: { hour: 12, minute: 0 } },
  { start: { hour: 14, minute: 0 }, end: { hour: 18, minute: 0 } },
]

const formatters = new Map()

function formatterFor(timeZone) {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
    formatters.set(timeZone, formatter)
  }
  return formatter
}

/**
 * 时区名是否被当前 Node 构建支持(IANA 名称 + ICU 能力)。
 * @param {string} timeZone - IANA 时区名(如 'Asia/Shanghai')。
 * @returns {boolean}
 */
export function isValidTimeZone(timeZone) {
  if (typeof timeZone !== 'string' || timeZone.length === 0) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

function partsToClock(parts) {
  const get = (type) => Number((parts.find(p => p.type === type) || {}).value || 0)
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
  }
}

/**
 * 把任意瞬时换算成参考时区的墙钟时间。绝不抛错:非法时区回退默认时区,
 * Intl 完全不可用(极老 Node / 缺 ICU)时对默认时区做 UTC+8 偏移兜底。
 * @param {Date} [now=new Date()] - 要换算的瞬时(默认当前时刻)。
 * @param {string} [timeZone=DEFAULT_TIME_ZONE] - IANA 时区名。
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }}
 */
export function referenceNow(now = new Date(), timeZone = DEFAULT_TIME_ZONE) {
  try {
    return partsToClock(formatterFor(timeZone).formatToParts(now))
  } catch {
    // 目标时区不可用:回退默认时区。
    try {
      return partsToClock(formatterFor(DEFAULT_TIME_ZONE).formatToParts(now))
    } catch {
      // Intl 完全不可用:仅对默认时区(UTC+8,无夏令时)做偏移兜底。
      const d = new Date(now.getTime() + FALLBACK_OFFSET_MS)
      return {
        year: d.getUTCFullYear(),
        month: d.getUTCMonth() + 1,
        day: d.getUTCDate(),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
      }
    }
  }
}

/** 单个时段是否包含某分钟数(start <= m < end,支持跨午夜)。 */
function inWindow(minutes, window) {
  const start = window.start.hour * 60 + window.start.minute
  const end = window.end.hour * 60 + window.end.minute
  if (end <= start) return minutes >= start || minutes < end
  return minutes >= start && minutes < end
}

/**
 * 判定参考时区墙钟时间是否处于高峰时段。
 * @param {{ hour: number, minute: number }} now - referenceNow() 的输出。
 * @param {Array<{start: {hour: number, minute: number}, end: {hour: number, minute: number}}>}
 *   [windows=PEAK_WINDOWS] - 高峰时段表,end <= start 表示跨午夜。
 * @returns {boolean}
 */
export function isPeakWindow(now, windows = PEAK_WINDOWS) {
  const minutes = now.hour * 60 + now.minute
  return windows.some(w => inWindow(minutes, w))
}
