// ═══ 业务工具集 —— 完成具体任务的工具 ═══
// 通过 Tool Registry 注册。所有路径操作限制在沙箱内（Tools Plugin 统一校验）

import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ToolsService, ToolDefinition } from './plugins/tools.js'
import type { SessionService } from './plugins/session.js'

export const registerBusinessTools = (tools: ToolsService, session: SessionService): void => {
  const sandbox = (p: unknown): string => {
    const path = String(p ?? '')
    // 相对路径统一落到 state/sandbox/ 下
    return path.startsWith('/') ? path : `./state/sandbox/${path}`
  }

  const defs: ToolDefinition[] = [
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'fs-read',
          description: '读取沙箱内文件内容',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string', description: '沙箱内相对路径' } },
            required: ['path'],
          },
        },
      },
      execute: async (args) => {
        const path = sandbox(args.path)
        if (!existsSync(path)) return { error: 'file not found' }
        return { content: readFileSync(path, 'utf8') }
      },
    },
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'fs-write',
          description: '写入沙箱内文件（自动创建父目录）',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: '沙箱内相对路径' },
              content: { type: 'string', description: '文件内容' },
              append: { type: 'boolean', description: '追加模式，默认false' },
            },
            required: ['path', 'content'],
          },
        },
      },
      execute: async (args) => {
        const path = sandbox(args.path)
        mkdirSync(dirname(path), { recursive: true })
        if (args.append) appendFileSync(path, String(args.content))
        else writeFileSync(path, String(args.content))
        return { ok: true, path, bytes: String(args.content).length }
      },
    },
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'http-get',
          description: 'HTTP GET 请求（只读，超时30s）',
          parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: '目标URL' } },
            required: ['url'],
          },
        },
      },
      execute: async (args) => {
        const url = String(args.url)
        const resp = await fetch(url, {
          headers: { 'User-Agent': 'SelfAgent/1.0' },
          signal: AbortSignal.timeout(30000),
        })
        const text = await resp.text()
        return { status: resp.status, body: text.slice(0, 10000) }
      },
    },
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'memory-write',
          description: '写短期记忆（当前任务上下文）',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
            required: ['content'],
          },
        },
      },
      execute: async (args) => {
        const entry = session.writeMemory('short', {
          content: String(args.content),
          tags: (args.tags as string[]) ?? [],
        })
        return { ok: true, id: entry.id }
      },
    },
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'memory-read',
          description: '读取记忆（short=短期, long=长期）',
          parameters: {
            type: 'object',
            properties: { scope: { type: 'string', enum: ['short', 'long'] } },
            required: ['scope'],
          },
        },
      },
      execute: async (args) => {
        const scope = args.scope === 'long' ? 'long' : 'short'
        return { entries: session.readMemory(scope).slice(-20) }
      },
    },
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'task-update',
          description: '更新任务状态',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              status: { type: 'string', enum: ['pending', 'active', 'done', 'failed'] },
              result: { type: 'string' },
            },
            required: ['id', 'status'],
          },
        },
      },
      execute: async (args) => {
        session.updateTask(String(args.id), {
          status: args.status as 'pending' | 'active' | 'done' | 'failed',
          result: args.result as string | undefined,
        })
        return { ok: true, state: session.getState().tasks }
      },
    },
    {
      category: 'business',
      schema: {
        type: 'function',
        function: {
          name: 'finish',
          description: '声明任务全部完成（所有任务 done 后调用，触发优雅自毁归档）',
          parameters: {
            type: 'object',
            properties: { summary: { type: 'string', description: '完成总结' } },
            required: ['summary'],
          },
        },
      },
      execute: async (args) => {
        const state = session.getState()
        const pending = state.tasks.filter((t) => t.status !== 'done')
        if (pending.length) {
          return { error: `${pending.length} task(s) not done yet`, pending: pending.map((t) => t.id) }
        }
        session.setState({ ...state, done: true })
        session.appendLog({ type: 'finish-called', summary: args.summary })
        return { ok: true, message: 'all tasks done, lifecycle will archive and terminate' }
      },
    },
  ]

  for (const def of defs) tools.register(def)
}
