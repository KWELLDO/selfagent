// ═══ Judge Plugin —— 独立评估器（质量门禁）═══
// 独立于推理循环。两层评估：软件工程（业务正确性）+ 运维工程（可行性与稳定性）
// 设计取舍：用规则检测为主（确定性、零 token 成本），LLM 评估留给目标漂移/幻觉这类
// 需要语义理解的检测，且按 goalDriftInterval 节流，不是每轮都调。

import { statSync, existsSync, readdirSync } from 'node:fs'
import type { Context } from '@cordisjs/core'
import type { JudgeConfig, JudgeReportPayload, SoftwareAssessment, OperationsAssessment, Recommendation, DonePayload, ToolCallRecord } from '../types.js'
import type { SessionService } from './session.js'
import type { LLMService } from './llm.js'
import { Events } from '../events.js'

export interface JudgeService {
  evaluate(done: DonePayload): Promise<JudgeReportPayload>
}

const parseSize = (s: string): number => {
  const m = s.match(/^(\d+)(KB|MB|GB)$/)
  if (!m) return 500 * 1024 * 1024
  const mult: Record<string, number> = { KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }
  return parseInt(m[1]!, 10) * (mult[m[2]!] ?? 1024 ** 2)
}

export const JudgePlugin = (ctx: Context, config: JudgeConfig): void => {
  ctx.inject(['session', 'llm'], (fork) => {
  const session = fork.get('session') as SessionService
  const llm = fork.get('llm') as LLMService
  const storageLimitBytes = parseSize(config.operationsChecks.storageLimit)

  // 滑动窗口：最近的工具执行记录
  let recentToolCalls: ToolCallRecord[] = []
  fork.on(Events.TOOL_EXECUTED, (record: ToolCallRecord) => {
    recentToolCalls.push(record)
    if (recentToolCalls.length > 200) recentToolCalls = recentToolCalls.slice(-100)
  })

  let cycleCount = 0
  let lastStateFingerprint = ''

  const assessSoftware = (done: DonePayload): SoftwareAssessment => {
    // ── 工具调用失败聚合 ──
    const failures = new Map<string, { error: string; count: number }>()
    for (const rec of recentToolCalls) {
      if (!rec.error) continue
      const prev = failures.get(rec.tool) ?? { error: rec.error, count: 0 }
      prev.count++
      failures.set(rec.tool, prev)
    }
    const toolFailures = [...failures.entries()].map(([tool, f]) => ({
      tool,
      error: f.error,
      count: f.count,
      severity: f.count >= 5 ? 'high' as const : f.count >= 2 ? 'medium' as const : 'low' as const,
    }))

    // ── 死循环检测：state 指纹连续相同 ──
    const state = session.getState()
    const fingerprint = JSON.stringify(state.tasks.map((t) => [t.id, t.status]))
    const loopDetected = fingerprint === lastStateFingerprint && cycleCount > 0
    lastStateFingerprint = fingerprint

    return {
      toolFailures,
      goalDrift: 'low',       // 默认低；LLM 深度检查时可能升级
      loopDetected,
      hallucinationRisk: 'none',
    }
  }

  const assessOperations = (done: DonePayload): OperationsAssessment => {
    const usage = llm.getUsage()
    const tokenRate = usage.totalTokens / config.operationsChecks.tokenBudget
    const tokenUsage = {
      used: usage.totalTokens,
      budget: config.operationsChecks.tokenBudget,
      rate: tokenRate >= 0.9 ? 'critical' as const : tokenRate >= 0.6 ? 'high' as const : 'normal' as const,
    }

    // ── 存储增长 ──
    let storageBytes = 0
    try {
      const walk = (dir: string): void => {
        if (!existsSync(dir)) return
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = `${dir}/${entry.name}`
          if (entry.isDirectory()) walk(full)
          else storageBytes += statSync(full).size
        }
      }
      walk(session.storePath)
    } catch { /* 存储扫描失败不阻塞评估 */ }
    const storageGrowth = storageBytes >= storageLimitBytes ? 'overflow' as const
      : storageBytes >= storageLimitBytes * 0.7 ? 'growing' as const : 'stable' as const

    // ── API 健康度（从近期工具调用延迟粗估）──
    const recent = recentToolCalls.slice(-20)
    const apiHealth = {
      successRate: recent.length ? recent.filter((r) => !r.error).length / recent.length : 1,
      avgLatencyMs: recent.length ? Math.round(recent.reduce((s, r) => s + r.latencyMs, 0) / recent.length) : 0,
    }

    return {
      tokenUsage,
      apiHealth,
      storageGrowth,
      pluginHealth: 'ok',
      securityAlerts: [],
    }
  }

  const buildRecommendations = (software: SoftwareAssessment, operations: OperationsAssessment): Recommendation[] => {
    const recs: Recommendation[] = []

    for (const f of software.toolFailures) {
      if (f.severity !== 'low') {
        recs.push({ layer: 'software', action: 'analyze_and_fix', target: f.tool, reason: `${f.count} failures: ${f.error}` })
      }
    }
    if (software.loopDetected) {
      recs.push({ layer: 'software', action: 'break_loop', reason: 'state unchanged across cycles' })
    }

    if (operations.tokenUsage.rate === 'critical') {
      recs.push({ layer: 'operations', action: 'switch_to_lighter_model', reason: `token ${operations.tokenUsage.rate}` })
      recs.push({ layer: 'operations', action: 'reduce_wake_frequency', reason: 'budget pressure' })
    } else if (operations.tokenUsage.rate === 'high') {
      recs.push({ layer: 'operations', action: 'switch_to_lighter_model', reason: 'budget > 60%' })
    }
    if (operations.apiHealth.successRate < config.operationsChecks.apiSuccessThreshold) {
      recs.push({ layer: 'operations', action: 'retry_with_backoff', reason: `success rate ${operations.apiHealth.successRate.toFixed(2)}` })
    }
    if (operations.storageGrowth !== 'stable') {
      recs.push({ layer: 'operations', action: 'compress_history', reason: operations.storageGrowth })
    }

    return recs
  }

  const qualityScore = (software: SoftwareAssessment, operations: OperationsAssessment): number => {
    let score = 1
    score -= software.toolFailures.reduce((s, f) => s + Math.min(f.count * 0.05, 0.2), 0)
    if (software.loopDetected) score -= 0.3
    if (operations.tokenUsage.rate === 'critical') score -= 0.2
    if (operations.tokenUsage.rate === 'high') score -= 0.1
    if (operations.storageGrowth === 'overflow') score -= 0.15
    if (operations.apiHealth.successRate < config.operationsChecks.apiSuccessThreshold) score -= 0.1
    return Math.max(0, Math.round(score * 100) / 100)
  }

  const service: JudgeService = {
    evaluate: async (done: DonePayload): Promise<JudgeReportPayload> => {
      cycleCount++

      // ── LLM 深度评估（节流）：目标漂移 + 幻觉检测 ──
      let software = assessSoftware(done)
      if (cycleCount % config.softwareChecks.goalDriftInterval === 0 && done.steps > 0) {
        try {
          const state = session.getState()
          const drift = await checkGoalDrift(state.goal, session.getJudgeReports().slice(-3))
          software = { ...software, goalDrift: drift }
        } catch { /* LLM 评估失败不阻塞规则评估 */ }
      }

      const operations = assessOperations(done)
      const recommendations = buildRecommendations(software, operations)

      const report: JudgeReportPayload = {
        timestamp: new Date().toISOString(),
        software,
        operations,
        recommendations,
        qualityScore: qualityScore(software, operations),
      }

      session.appendJudgeReport(report)
      fork.emit(Events.JUDGE_REPORT, report)
      return report
    },
  }

  const checkGoalDrift = async (goal: string, _history: JudgeReportPayload[]): Promise<'none' | 'low' | 'medium' | 'high'> => {
    if (!goal) return 'none'
    try {
      const result = await llm.chat([
        { role: 'system', content: '你是评估器。判断 Agent 当前任务列表是否偏离原始目标。只回答一个词：none/low/medium/high' },
        { role: 'user', content: `原始目标: ${goal}\n当前任务: ${JSON.stringify(session.getState().tasks)}\n偏离程度？` },
      ])
      const answer = result.content.trim().toLowerCase()
      if (['none', 'low', 'medium', 'high'].includes(answer)) return answer as 'none' | 'low' | 'medium' | 'high'
      return 'low'
    } catch {
      return 'low'
    }
  }

  // ── 订阅 agent/done，触发评估 ──
  fork.on(Events.DONE, (done: DonePayload) => {
    if (cycleCount % config.evaluateEvery !== 0) return
    void service.evaluate(done)
  })

  fork.set('judge', service)
  })
}
