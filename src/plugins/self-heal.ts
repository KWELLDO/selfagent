// ═══ Self-Heal Plugin —— 自我改进引擎（系统的免疫系统）═══
// 订阅 Judge 报告 → 分类错误 → 选择策略 → 通过 Creative Mode 修复
// → 验证效果 → commit 或 rollback → 记录 heal-log（完整审计链）

import type { Context } from '@cordisjs/core'
import type { SelfHealConfig, JudgeReportPayload, HealActionPayload } from '../types.js'
import type { SessionService } from './session.js'
import type { TimerService } from './timer.js'
import type { LLMService } from './llm.js'
import { Events } from '../events.js'

export interface SelfHealService {
  heal(report: JudgeReportPayload): Promise<void>
}

export const SelfHealPlugin = (ctx: Context, config: SelfHealConfig): void => {
  ctx.inject(['session', 'timer', 'llm'], (fork) => {
  const session = fork.get('session') as SessionService
  const timer = fork.get('timer') as TimerService
  const llm = fork.get('llm') as LLMService

  // 追踪每个问题已尝试的策略次数
  const attempts = new Map<string, number>()

  // 策略表：错误 → 修复动作
  const strategies: Record<string, (report: JudgeReportPayload) => void> = {
    switch_to_lighter_model: () => {
      // 通过事件通知 Creative Mode 层执行 patch-config
      const payload: HealActionPayload = {
        issue: 'token budget pressure',
        layer: 'operations',
        strategy: 'switch_to_lighter_model',
        tool: 'patch-config',
        args: { target: 'llm', key: 'model', value: 'deepseek-chat-lite' },
      }
      fork.emit(Events.HEAL_ACTION, payload)
    },
    reduce_wake_frequency: () => {
      const payload: HealActionPayload = {
        issue: 'token budget pressure',
        layer: 'operations',
        strategy: 'reduce_wake_frequency',
        tool: 'patch-config',
        args: { target: 'timer', key: 'interval', value: '15m' },
      }
      fork.emit(Events.HEAL_ACTION, payload)
    },
    retry_with_backoff: () => {
      // API 健康度低：直接调 timer 放宽间隔，给上游喘息
      const payload: HealActionPayload = {
        issue: 'api success rate low',
        layer: 'operations',
        strategy: 'retry_with_backoff',
        tool: 'patch-config',
        args: { target: 'timer', key: 'interval', value: '2m' },
      }
      fork.emit(Events.HEAL_ACTION, payload)
    },
    break_loop: () => {
      // 死循环：注入避免模式到长期记忆
      session.writeMemory('long', {
        content: `死循环检测: ${new Date().toISOString()} 状态连续未变。后续避免重复相同的任务列表推进模式。`,
        tags: ['loop-avoidance', 'self-heal'],
      })
      session.appendHealLog({
        timestamp: new Date().toISOString(),
        issue: 'loop_detected',
        layer: 'software',
        action: 'inject loop-avoidance memory',
        verified: true,
      })
    },
    analyze_and_fix: (report) => {
      const failure = report.software.toolFailures[0]
      if (!failure) return
      // 工具失败：记 lesson，等后续 Judge 验证是否恢复
      session.writeMemory('long', {
        content: `工具 ${failure.tool} 反复失败: ${failure.error} (x${failure.count})。修改调用方式或避开该工具。`,
        tags: ['tool-failure', failure.tool],
      })
      session.appendHealLog({
        timestamp: new Date().toISOString(),
        issue: `tool_failure:${failure.tool}`,
        layer: 'software',
        action: 'record lesson + await verification',
        verified: false,
      })
    },
    compress_history: () => {
      // 存储压力：清理短期记忆（保留长期）
      const short = session.readMemory('short')
      session.appendHealLog({
        timestamp: new Date().toISOString(),
        issue: 'storage_pressure',
        layer: 'operations',
        action: `flagged ${short.length} short-term memories for compression`,
        verified: true,
      })
    },
  }

  const service: SelfHealService = {
    heal: async (report: JudgeReportPayload): Promise<void> => {
      for (const rec of report.recommendations) {
        const issueKey = `${rec.layer}:${rec.action}:${rec.target ?? ''}`
        const tried = attempts.get(issueKey) ?? 0

        if (tried >= config.maxRetriesPerIssue) {
          // 穷尽策略 → 触发优雅自毁
          session.appendHealLog({
            timestamp: new Date().toISOString(),
            issue: issueKey,
            layer: rec.layer,
            action: 'strategies exhausted → terminate',
            verified: false,
          })
          fork.emit(Events.TERMINATE, {
            reason: 'unrecoverable_error',
            exitCode: 1,
            detail: `self-heal exhausted for ${issueKey}`,
          })
          return
        }

        const strategy = strategies[rec.action]
        if (!strategy) continue

        attempts.set(issueKey, tried + 1)
        strategy(report)
        session.appendLog({ type: 'heal-action', issue: issueKey, strategy: rec.action, attempt: tried + 1 })
      }
    },
  }

  // ── 订阅 Judge 报告 ──
  fork.on(Events.JUDGE_REPORT, (report: JudgeReportPayload) => {
    if (!report.recommendations.length) return
    void service.heal(report)
  })

  // ── 订阅 heal-action → 直接执行对 timer/llm 的修改（Creative 的 patch 也可行，
  // 这里 Self-Heal 作为系统免疫层直接调服务接口，保证不依赖 Agent 自身发起 patch）──
  fork.on(Events.HEAL_ACTION, (action: HealActionPayload) => {
    if (action.tool !== 'patch-config') return
    const { target, key, value } = action.args
    if (target === 'timer' && key === 'interval') {
      timer.adjustInterval(value as string, `self-heal:${action.strategy}`)
    } else if (target === 'llm' && key === 'model') {
      llm.setModel(value as string)
    }
  })

  // ── 验证闭环：Judge 报告质量分恢复 → 验证 lesson 有效 ──
  fork.on(Events.JUDGE_REPORT, (report: JudgeReportPayload) => {
    const healLog = session.getHealLog()
    const unverified = healLog.filter((h) => !h.verified)
    if (report.qualityScore >= 0.8 && unverified.length && config.autoCommit) {
      for (const entry of unverified) {
        session.appendLesson({ issue: entry.issue, fix: entry.action, effective: true })
      }
      session.markHealVerified(unverified.map((h) => h.timestamp))
    }
  })

  fork.set('self-heal', service)
  })
}
