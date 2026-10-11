// ═══ Creative Mode Plugin —— 运行时自省与修改（Agent 的自我接口层）═══
// 借鉴 DSH 创造模式：Agent 可以看见并操作自己的运行时
// 试验与提交分离：修改先在内存生效 → Judge 验证 → commit-change 落盘 / rollback 回滚

import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Context } from '@cordisjs/core'
import type { CreativeConfig, JudgeReportPayload, RuntimeModifiedPayload } from '../types.js'
import type { SessionService } from './session.js'
import type { TimerService } from './timer.js'
import type { LLMService } from './llm.js'
import type { ToolsService } from './tools.js'

export interface CreativeService {
  runtimeSnapshot(): string
}

// 内存试验层：未提交的修改
interface PendingChange {
  target: string          // 插件名
  key: string             // 配置键
  oldValue: unknown
  newValue: unknown
}

export const CreativePlugin = (ctx: Context, config: CreativeConfig): void => {
  ctx.inject(['session', 'timer', 'llm', 'tools'], (fork) => {
  const session = fork.get('session') as SessionService
  const timer = fork.get('timer') as TimerService
  const llm = fork.get('llm') as LLMService
  const tools = fork.get('tools') as ToolsService
  const pendingChanges: PendingChange[] = []

  // ── 安全边界检查 ──
  const matchAny = (name: string, patterns: string[]): boolean =>
    patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p))

  const isForbidden = (target: string): boolean =>
    matchAny(target, config.runtimeForbidden.patchConfig)

  // ── 运行时自省工具 ──
  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'inspect-runtime',
        description: '列出当前加载的插件和服务清单',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    execute: async () => ({
      plugins: ['session', 'lifecycle', 'timer', 'event', 'llm', 'tools', 'loop', 'judge', 'self-heal', 'creative'],
      services: ['session', 'timer', 'event', 'llm', 'tools', 'loop', 'judge', 'self-heal', 'creative'],
      state: { generation: session.getState().generation, done: session.getState().done },
      pendingChanges: pendingChanges.length,
    }),
  })

  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'read-config',
        description: '读取当前生效的配置（含未提交的修改层叠结果）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    execute: async () => ({
      timer: { interval: timer.getInterval(), enabled: timer.isEnabled() },
      llm: { usage: llm.getUsage() },
      pending: pendingChanges.map((c) => ({ target: c.target, key: c.key, newValue: c.newValue })),
    }),
  })

  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'read-heal-log',
        description: '读取历史自我改进记录',
        parameters: { type: 'object', properties: { limit: { type: 'number', description: '最多返回条数，默认10' } }, required: [] },
      },
    },
    execute: async (args) => {
      const log = session.getHealLog()
      const limit = (args.limit as number) ?? 10
      return log.slice(-limit)
    },
  })

  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'read-judge-report',
        description: '读取最近的评估报告',
        parameters: { type: 'object', properties: { count: { type: 'number', description: '返回最近N份，默认1' } }, required: [] },
      },
    },
    execute: async (args) => {
      const reports = session.getJudgeReports()
      const count = (args.count as number) ?? 1
      return reports.slice(-count)
    },
  })

  // ── 运行时修改工具 ──
  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'patch-config',
        description: '修改插件配置（内存试验，未提交前不影响落盘配置）。可改：llm/timer/loop/tools；禁止改：judge/self-heal/lifecycle',
        parameters: {
          type: 'object',
          properties: {
            target: { type: 'string', description: '目标插件名：timer / llm' },
            key: { type: 'string', description: '配置键：interval / model / temperature / max_tokens' },
            value: { description: '新值' },
          },
          required: ['target', 'key', 'value'],
        },
      },
    },
    execute: async (args) => {
      const target = args.target as string
      const key = args.key as string
      const value = args.value

      if (isForbidden(target)) {
        return { error: `forbidden: cannot patch ${target} (runtime_forbidden.patch_config)` }
      }

      // 立即生效的内存试验
      if (target === 'timer' && key === 'interval') {
        timer.adjustInterval(value as string, 'agent patch-config')
      } else if (target === 'llm' && key === 'model') {
        llm.setModel(value as string)
      } else {
        return { error: `unsupported patch target/key: ${target}.${key}` }
      }

      pendingChanges.push({ target, key, oldValue: undefined, newValue: value })
      const payload: RuntimeModifiedPayload = { target, change: `${key}=${JSON.stringify(value)}`, reversible: true }
      fork.emit('runtime/modified', payload)
      return { ok: true, message: `${target}.${key} patched (in-memory, pending commit)`, pendingCount: pendingChanges.length }
    },
  })

  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'commit-change',
        description: '将内存中的修改持久化到配置文件（仅验证通过的修改应提交）',
        parameters: { type: 'object', properties: {}, required: [] },
      },
    },
    execute: async () => {
      if (!pendingChanges.length) return { ok: true, message: 'nothing to commit' }
      const configFile = join(session.storePath, 'config', 'patches.json')
      const existing = existsSync(configFile) ? JSON.parse(readFileSync(configFile, 'utf8')) : []
      existing.push(...pendingChanges.map(({ target, key, newValue }) => ({ target, key, value: newValue, committedAt: new Date().toISOString() })))
      mkdirSync(dirname(configFile), { recursive: true })
      writeFileSync(configFile, JSON.stringify(existing, null, 2))
      const committed = pendingChanges.length
      pendingChanges.length = 0
      return { ok: true, committed, message: `committed ${committed} change(s) to ${configFile}` }
    },
  })

  tools.register({
    category: 'runtime',
    schema: {
      type: 'function',
      function: {
        name: 'rollback-change',
        description: '回滚未持久化的内存修改（Cordis 可逆效应保证干净逆转）',
        parameters: { type: 'object', properties: { all: { type: 'boolean', description: '是否回滚全部，默认true' } }, required: [] },
      },
    },
    execute: async (args) => {
      const all = args.all !== false
      if (all) {
        const rolled = pendingChanges.length
        pendingChanges.length = 0
        return { ok: true, rolledBack: rolled }
      }
      const last = pendingChanges.pop()
      return { ok: true, rolledBack: last ? 1 : 0 }
    },
  })

  // ── 运行时快照（注入系统提示词）──
  const runtimeSnapshot = (): string => `- Timer 间隔: ${timer.getInterval() ?? '未设置'}, 启用: ${timer.isEnabled()}
- LLM 累计 token: ${llm.getUsage().totalTokens}, 调用次数: ${llm.getUsage().totalCalls}
- 待提交修改: ${pendingChanges.length} 项
- 可用运行时工具: inspect-runtime, read-config, read-heal-log, read-judge-report, patch-config, commit-change, rollback-change`

  const service: CreativeService = { runtimeSnapshot }
  fork.set('creative', service)

  // 卸载时清 pending（可逆效应的自然清理）
  fork.effect(() => () => { pendingChanges.length = 0 })
  })
}
