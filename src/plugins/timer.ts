// ═══ Timer Plugin —— 定时唤醒（Agent 的心跳）═══
// 按 cron/interval 发布 agent/wake，支持静默期、冷却期、自适应间隔调整

import cronParser from 'cron-parser'
import type { Context } from '@cordisjs/core'
import type { TimerConfig, WakePayload } from '../types.js'

export interface TimerService {
  adjustInterval(newInterval: string, reason: string): void
  getInterval(): string | null
  getNextFire(): Date | null
  setEnabled(enabled: boolean): void
  isEnabled(): boolean
}

const parseDuration = (s: string): number => {
  const m = s.match(/^(\d+)(ms|s|m|h|d)$/)
  if (!m) throw new Error(`invalid duration: ${s}`)
  const n = parseInt(m[1]!, 10)
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000, d: 86400000 }
  return n * (mult[m[2]!] ?? 1000)
}

export const TimerPlugin = (ctx: Context, config: TimerConfig): void => {
  let timer: ReturnType<typeof setTimeout> | null = null
  let enabled = true
  const defaultInterval = config.interval ? parseDuration(config.interval) : 300000
  let intervalMs = defaultInterval
  const cooldownMs = parseDuration(config.cooldown ?? '30s')
  let lastFire = 0
  let intervalOverride: string | null = null
  let wakeCounter = 0

  const inQuietHours = (): boolean => {
    if (!config.quietHours) return false
    const now = new Date()
    const mins = now.getHours() * 60 + now.getMinutes()
    const [sh, sm] = config.quietHours.start.split(':').map(Number)
    const [eh, em] = config.quietHours.end.split(':').map(Number)
    const start = sh * 60 + sm
    const end = eh * 60 + em
    return start <= end ? mins >= start && mins < end : mins >= start || mins < end
  }

  const fire = (): void => {
    const now = Date.now()
    if (!enabled) return
    if (now - lastFire < cooldownMs) { schedule(); return }
    if (inQuietHours()) { schedule(); return }
    lastFire = now
    const payload: WakePayload = {
      reason: 'timer',
      timestamp: new Date().toISOString(),
      detail: `wake#${++wakeCounter}`,
    }
    ctx.emit('agent/wake', payload)
    schedule()
  }

  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    if (!enabled) return
    let delay: number
    if (config.cron && !intervalOverride) {
      try {
        const expr = cronParser.parseExpression(config.cron)
        delay = expr.next().getTime() - Date.now()
      } catch {
        delay = intervalMs
      }
    } else {
      delay = intervalOverride ? parseDuration(intervalOverride) : intervalMs
    }
    timer = setTimeout(fire, Math.max(delay, 1000))
  }

  const service: TimerService = {
    adjustInterval: (newInterval, reason) => {
      intervalOverride = newInterval
      intervalMs = parseDuration(newInterval)
      ctx.emit('timer/adjusted', { interval: newInterval, reason })
      schedule() // 立即用新间隔重排
    },
    getInterval: () => intervalOverride ?? (config.cron ? `cron:${config.cron}` : config.interval ?? null),
    getNextFire: () => {
      if (config.cron && !intervalOverride) {
        try { return cronParser.parseExpression(config.cron).next().toDate() } catch { return null }
      }
      return new Date(Date.now() + (intervalOverride ? parseDuration(intervalOverride) : intervalMs))
    },
    setEnabled: (v) => { enabled = v; if (v) schedule(); else if (timer) { clearTimeout(timer); timer = null } },
    isEnabled: () => enabled,
  }

  ctx.set('timer', service)
  schedule()

  // 插件卸载时清定时器（Cordis 可逆效应）
  ctx.effect(() => () => {
    if (timer) clearTimeout(timer)
  })
}
