import { test } from 'node:test'
import assert from 'node:assert/strict'
import { referenceNow, isPeakWindow, PEAK_WINDOWS } from '../lib/timezone.js'

test('referenceNow 把 UTC 换算到 Asia/Shanghai', () => {
  const now = referenceNow(new Date('2026-08-17T01:06:37Z'), 'Asia/Shanghai')
  assert.deepEqual(now, { year: 2026, month: 8, day: 17, hour: 9, minute: 6 })
})

test('跨日换算:UTC 前一天晚上 → 北京次日凌晨', () => {
  const now = referenceNow(new Date('2026-08-16T16:30:00Z'), 'Asia/Shanghai')
  assert.deepEqual(now, { year: 2026, month: 8, day: 17, hour: 0, minute: 30 })
})

test('午夜不产生 24 点(hourCycle h23)', () => {
  const now = referenceNow(new Date('2026-08-16T16:00:00Z'), 'Asia/Shanghai')
  assert.equal(now.hour, 0)
})

test('高峰边界:09:00 含、12:00 不含', () => {
  assert.equal(isPeakWindow({ hour: 9, minute: 0 }), true)
  assert.equal(isPeakWindow({ hour: 11, minute: 59 }), true)
  assert.equal(isPeakWindow({ hour: 12, minute: 0 }), false)
  assert.equal(isPeakWindow({ hour: 13, minute: 59 }), false)
})

test('高峰边界:14:00 含、18:00 不含', () => {
  assert.equal(isPeakWindow({ hour: 14, minute: 0 }), true)
  assert.equal(isPeakWindow({ hour: 17, minute: 59 }), true)
  assert.equal(isPeakWindow({ hour: 18, minute: 0 }), false)
})

test('空闲时段:其余时间全部非高峰', () => {
  assert.equal(isPeakWindow({ hour: 0, minute: 0 }), false)
  assert.equal(isPeakWindow({ hour: 8, minute: 59 }), false)
  assert.equal(isPeakWindow({ hour: 12, minute: 30 }), false)
  assert.equal(isPeakWindow({ hour: 13, minute: 0 }), false)
  assert.equal(isPeakWindow({ hour: 23, minute: 59 }), false)
})

test('官方高峰时段表为 09:00-12:00 / 14:00-18:00', () => {
  assert.deepEqual(PEAK_WINDOWS, [
    { start: { hour: 9, minute: 0 }, end: { hour: 12, minute: 0 } },
    { start: { hour: 14, minute: 0 }, end: { hour: 18, minute: 0 } },
  ])
})

test('自定义时段支持跨午夜(end <= start)', () => {
  const windows = [{ start: { hour: 23, minute: 0 }, end: { hour: 6, minute: 0 } }]
  assert.equal(isPeakWindow({ hour: 23, minute: 30 }, windows), true)
  assert.equal(isPeakWindow({ hour: 2, minute: 0 }, windows), true)
  assert.equal(isPeakWindow({ hour: 6, minute: 0 }, windows), false)
  assert.equal(isPeakWindow({ hour: 12, minute: 0 }, windows), false)
})
