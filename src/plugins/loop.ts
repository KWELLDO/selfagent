// ═══ Agent Loop Plugin —— 推理循环（Ralph Loop 模式）═══
// 最薄的一层：不存状态、不管工具、不接模型，只编排循环
// 所有依赖通过 Cordis 服务注入获取

import { readFileSync, existsSync } from 'node:fs'
import type { Context } from '@cordisjs/core'
import type { LoopConfig, ChatMessage, WakePayload, FeedbackPayload, DonePayload, Task } from '../types.js'
import type { SessionService } from './session.js'
import type { LLMService } from './llm.js'
import type { ToolsService } from './tools.js'
import type { CreativeService } from './creative.js'
import { Events } from '../events.js'

const parseDuration = (s: string): number => {
  const m = s.match(/^(\d+)(ms|s|m|h)$/)
  if (!m) return 7200000
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000, h: 3600000 }
  return parseInt(m[1]!, 10) * (mult[m[2]!] ?? 1000)
}

export interface LoopService {
  runCycle(reason: 'timer' | 'feedback', detail?: string): Promise<void>
  isRunning(): boolean
}

export const AgentLoopPlugin = (ctx: Context, config: LoopConfig): void => {
  ctx.inject(['session', 'llm', 'tools'], (fork) => {
  let running = false
  let pendingFeedback: FeedbackPayload[] = []
  let currentAbort: AbortController | null = null

  const session = fork.get('session') as SessionService
  const llm = fork.get('llm') as LLMService
  const tools = fork.get('tools') as ToolsService

  const buildSystemPrompt = (): string => {
    let base = ''
    if (config.systemPromptPath && existsSync(config.systemPromptPath)) {
      base = readFileSync(config.systemPromptPath, 'utf8')
    }
    // 运行时快照注入（Creative Mode 开启时）
    if (config.creativeMode) {
      const creative = fork.get('creative') as CreativeService
      if (creative) {
        base += '\n\n## 当前运行时状态\n' + creative.runtimeSnapshot()
      }
    }
    return base
  }

  const loadFeedbackContext = (): string => {
    if (!pendingFeedback.length) return ''
    const lines = pendingFeedback.map((f) => `[反馈 ${f.source}] ${f.content}`)
    pendingFeedback = []
    return '\n\n## 待处理的外部反馈\n' + lines.join('\n')
  }

  const runCycle = async (reason: 'timer' | 'feedback', detail?: string): Promise<void> => {
    if (running) return // 单轮循环保护
    running = true
    currentAbort = new AbortController()
    const wakeId = `wake-${Date.now().toString(36)}`
    const state = session.getState()
    const startedAt = Date.now()
    let step = 0
    let toolCallCount = 0
    let success = true
    let error: string | undefined

    session.setState({ ...state, lastWakeAt: new Date().toISOString() })

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt() + loadFeedbackContext() },
      { role: 'user', content: buildUserPrompt() },
    ]

    const maxRuntimeMs = parseDuration(config.termination.maxRuntime)

    try {
      while (step < config.maxSteps) {
        if (Date.now() - startedAt > maxRuntimeMs) {
          error = `max runtime exceeded: ${config.termination.maxRuntime}`
          break
        }

        const businessTools = tools.getSchemas('business')
        const runtimeTools = config.creativeMode ? tools.getSchemas('runtime') : []
        const result = await llm.chat(messages, [...businessTools, ...runtimeTools])

        step++
        messages.push({
          role: 'assistant',
          content: result.content || null,
          tool_calls: result.toolCalls,
        })

        if (!result.toolCalls.length) {
          // LLM 输出最终结果，无工具调用 → 本轮结束
          break
        }

        // 执行所有工具调用
        for (const call of result.toolCalls) {
          toolCallCount++
          const { result: toolResult, error: toolError } = await tools.execute(call, step)
          messages.push({
            role: 'tool',
            content: toolError ? `ERROR: ${toolError}` : JSON.stringify(toolResult ?? null),
            tool_call_id: call.id,
          })
        }
      }
    } catch (err) {
      success = false
      error = err instanceof Error ? err.message : String(err)
    }

    // ── 更新状态 ──
    const finalState = session.getState()
    session.setState({
      ...finalState,
      consecutiveFailures: success ? 0 : finalState.consecutiveFailures + 1,
    })

    // ── 记录日志 ──
    session.appendLog({
      type: 'wake-complete',
      wakeId, reason, detail, steps: step, toolCalls: toolCallCount,
      success, error, durationMs: Date.now() - startedAt,
    })

    // ── 发布 agent/done（Judge 监听）──
    const payload: DonePayload = { wakeId, steps: step, toolCalls: toolCallCount, tokensUsed: llm.getUsage().totalTokens, success, error }
    fork.emit(Events.DONE, payload)

    // ── 连续失败超限 → 触发终止 ──
    const afterState = session.getState()
    if (afterState.consecutiveFailures >= config.termination.maxConsecutiveFailures) {
      fork.emit(Events.TERMINATE, {
        reason: 'unrecoverable_error',
        exitCode: 1,
        detail: `${afterState.consecutiveFailures} consecutive failures`,
      })
    }

    running = false
    currentAbort = null
  }

  const buildUserPrompt = (): string => {
    const state = session.getState()
    const parts: string[] = []

    parts.push(`# 目标\n${state.goal}`)

    if (state.tasks.length) {
      parts.push(`# 任务列表（状态：pending/active/done/failed）\n` +
        state.tasks.map((t: Task) => `- [${t.status}] ${t.id}: ${t.description}${t.result ? ` → 结果: ${t.result}` : ''}`).join('\n'))
    }

    const shortMemory = session.readMemory('short')
    if (shortMemory.length) {
      parts.push(`# 短期记忆\n` + shortMemory.slice(-10).map((m) => `- ${m.content}`).join('\n'))
    }

    const lessons = session.getLessons()
    if (lessons.length) {
      const effective = lessons.filter((l) => l.effective)
      if (effective.length) {
        parts.push(`# 经验教训（前代验证有效的修复）\n` +
          effective.slice(-5).map((l) => `- ${l.issue} → ${l.fix}`).join('\n'))
      }
    }

    const judgeReports = session.getJudgeReports()
    const lastReport = judgeReports[judgeReports.length - 1]
    if (lastReport?.recommendations.length) {
      parts.push(`# Judge 上轮建议\n` + lastReport.recommendations.map((r) => `- [${r.layer}] ${r.action}${r.target ? ` (${r.target})` : ''}: ${r.reason ?? ''}`).join('\n'))
    }

    parts.push(`# 当前要求
读取状态后，推进任务。完成后用最终回复总结本轮工作。如果没有剩余任务且目标已达成，在回复中明确说「任务完成」。`)
    return parts.join('\n\n')
  }

  // ── 事件订阅：双驱动模型 ──
  // 定时唤醒
  fork.on(Events.WAKE, (payload: WakePayload) => {
    void runCycle(payload.reason, payload.detail)
  })

  // 反馈触发：优先于定时（feedbackPriority）
  fork.on(Events.FEEDBACK, (payload: FeedbackPayload) => {
    if (config.feedbackPriority) {
      pendingFeedback.push(payload)
    }
    void runCycle('feedback', `feedback:${payload.source}`)
  })

  // 外部终止：中断当前循环
  fork.on(Events.TERMINATE, (payload: { reason: string }) => {
    if (payload.reason === 'external_kill' && currentAbort) {
      currentAbort.abort()
    }
  })

  const service: LoopService = {
    runCycle: (reason, detail) => runCycle(reason, detail),
    isRunning: () => running,
  }

  fork.set('loop', service)
  })
}
