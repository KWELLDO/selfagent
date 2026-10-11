// ═══ Tool Registry Plugin —— 工具管理 ═══
// 注册、发现、执行工具。执行流水线：hook → 权限 → 沙箱 → 超时 → 执行 → 校验 → 后处理

import { resolve, normalize, isAbsolute } from 'node:path'
import type { Context } from '@cordisjs/core'
import type { ToolsConfig, ToolSchema, ToolCallRequest, ToolCallRecord } from '../types.js'

export interface ToolDefinition {
  schema: ToolSchema
  execute: (args: Record<string, unknown>) => Promise<unknown>
  /** 工具类别：业务工具 vs 运行时工具（由 Creative Mode 注册） */
  category: 'business' | 'runtime'
}

export interface ToolsService {
  register(tool: ToolDefinition): void
  unregister(name: string): boolean
  list(): string[]
  getSchemas(category?: 'business' | 'runtime'): ToolSchema[]
  execute(call: ToolCallRequest, step: number): Promise<{ result?: unknown; error?: string; record: ToolCallRecord }>
}

const parseDuration = (s: string): number => {
  const m = s.match(/^(\d+)(ms|s|m)$/)
  if (!m) return 30000
  const mult: Record<string, number> = { ms: 1, s: 1000, m: 60000 }
  return parseInt(m[1]!, 10) * (mult[m[2]!] ?? 1000)
}

const matchAny = (name: string, patterns: string[]): boolean =>
  patterns.some((p) => (p.endsWith('*') ? name.startsWith(p.slice(0, -1)) : name === p))

export const ToolsPlugin = (ctx: Context, config: ToolsConfig): void => {
  const tools = new Map<string, ToolDefinition>()
  const sandboxRoot = resolve(process.cwd(), './state/sandbox')
  const timeoutMs = parseDuration(config.timeout)

  const checkPathSandbox = (p: unknown): boolean => {
    if (!config.sandbox || typeof p !== 'string') return true
    if (!isAbsolute(p)) return true // 相对路径视为沙箱内
    return normalize(p).startsWith(sandboxRoot)
  }

  const service: ToolsService = {
    register: (tool) => { tools.set(tool.schema.function.name, tool) },
    unregister: (name) => tools.delete(name),
    list: () => [...tools.keys()],
    getSchemas: (category) =>
      [...tools.values()].filter((t) => !category || t.category === category).map((t) => t.schema),

    execute: async (call, step) => {
      const tool = tools.get(call.name)
      const started = Date.now()

      if (!tool) {
        const record: ToolCallRecord = {
          tool: call.name, args: call.arguments, error: `tool not found: ${call.name}`,
          latencyMs: 0, timestamp: new Date().toISOString(), step,
        }
        ctx.emit('tool/executed', record)
        return { error: record.error, record }
      }

      // ── 权限检查 ──
      const needsApproval = matchAny(call.name, config.approval.requireApproval)
      if (needsApproval) {
        // 自动运行环境：非交互式，对 require_approval 工具默认拒绝（除非明确批准列表）
        const record: ToolCallRecord = {
          tool: call.name, args: call.arguments, error: 'permission denied (approval required)',
          latencyMs: 0, timestamp: new Date().toISOString(), step,
        }
        ctx.emit('tool/executed', record)
        return { error: record.error, record }
      }

      // ── 沙箱检查（路径类参数）──
      const pathKeys = ['path', 'file', 'filePath', 'dir', 'directory']
      for (const key of pathKeys) {
        if (call.arguments[key] !== undefined && !checkPathSandbox(call.arguments[key])) {
          const record: ToolCallRecord = {
            tool: call.name, args: call.arguments, error: `sandbox violation: ${key} escapes sandbox`,
            latencyMs: 0, timestamp: new Date().toISOString(), step,
          }
          ctx.emit('tool/executed', record)
          return { error: record.error, record }
        }
      }

      // ── 超时控制 + 执行 ──
      try {
        const result = await Promise.race([
          tool.execute(call.arguments),
          new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs)),
        ])
        const record: ToolCallRecord = {
          tool: call.name, args: call.arguments, result,
          latencyMs: Date.now() - started, timestamp: new Date().toISOString(), step,
        }
        ctx.emit('tool/executed', record)
        return { result, record }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err)
        const record: ToolCallRecord = {
          tool: call.name, args: call.arguments, error,
          latencyMs: Date.now() - started, timestamp: new Date().toISOString(), step,
        }
        ctx.emit('tool/executed', record)
        return { error, record }
      }
    },
  }

  ctx.set('tools', service)
}
