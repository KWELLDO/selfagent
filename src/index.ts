// ═══ 主入口 —— 装配十插件，启动 Agent ═══
// 用法：
//   tsx src/index.ts --task examples/daily-note/task.json    # 端到端任务模式
//   tsx src/index.ts --daemon                                # 常驻模式（Timer 驱动）
//   tsx src/index.ts --task t.json --once                     # 跑一个唤醒周期即退出

import { readFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { Context } from '@cordisjs/core'
import type { PluginConfigs, Task } from './types.js'
import './augment.js' // 事件类型声明合并（必须最先加载）
import { SessionPlugin } from './plugins/session.js'
import { LifecyclePlugin } from './plugins/lifecycle.js'
import { TimerPlugin } from './plugins/timer.js'
import { EventPlugin } from './plugins/event.js'
import { LLMPlugin } from './plugins/llm.js'
import { ToolsPlugin } from './plugins/tools.js'
import { AgentLoopPlugin } from './plugins/loop.js'
import { JudgePlugin } from './plugins/judge.js'
import { SelfHealPlugin } from './plugins/self-heal.js'
import { CreativePlugin } from './plugins/creative.js'
import { registerBusinessTools } from './business-tools.js'
import type { SessionService } from './plugins/session.js'
import type { ToolsService } from './plugins/tools.js'
import type { LoopService } from './plugins/loop.js'
import type { LifecycleService } from './plugins/lifecycle.js'

// ── 解析命令行 ──
const args = process.argv.slice(2)
const getArg = (name: string): string | undefined => {
  const idx = args.indexOf(name)
  return idx >= 0 ? args[idx + 1] : undefined
}
const taskFile = getArg('--task')
const daemonMode = args.includes('--daemon')
const onceMode = args.includes('--once')

// ── 默认配置（可用 state/config/cordis.json 覆盖）──
const defaultConfig: PluginConfigs = {
  session: { storePath: './state', memory: { shortTermTtl: '24h', longTermPersist: true } },
  lifecycle: {
    archive: { path: './state/archive', compress: true, retention: '30d' },
    inheritance: { loadLessons: true },
    maxLifespan: '7d',
  },
  timer: { interval: '5m', adaptive: true, cooldown: '30s' },
  event: { idempotency: { store: 'session', ttl: '24h' }, sources: [] },
  llm: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxTokens: 8192,
    temperature: 0.7,
    retry: { maxRetries: 3, backoff: 'exponential' },
  },
  tools: {
    sandbox: true,
    approval: { autoApprove: ['read-*', 'search-*', 'inspect-*', 'memory-*', 'task-*', 'fs-read', 'http-get'], requireApproval: ['write-*', 'execute-*', 'install-*'] },
    timeout: '30s',
  },
  loop: {
    maxSteps: 50,
    systemPromptPath: './prompts/base.md',
    creativeMode: true,
    feedbackPriority: true,
    termination: { maxConsecutiveFailures: 5, maxRuntime: '2h' },
  },
  judge: {
    evaluateEvery: 1,
    softwareChecks: { goalDriftInterval: 5, loopThreshold: 3 },
    operationsChecks: { tokenBudget: 100000, storageLimit: '500MB', apiSuccessThreshold: 0.9 },
  },
  selfHeal: { maxRetriesPerIssue: 3, verifyRounds: 3, autoCommit: true },
  creative: {
    runtimeForbidden: {
      uninstall: ['judge', 'self-heal', 'lifecycle'],
      patchConfig: ['judge.*', 'self-heal.*', 'lifecycle.*'],
      install: ['@my-agent/judge-*', '@my-agent/self-heal-*', '@my-agent/lifecycle-*'],
    },
    shutdownAllowed: { uninstall: ['*'], archive: ['*'] },
  },
}

// 读取用户覆盖配置
const configOverridePath = './state/config/cordis.json'
let config = defaultConfig
if (existsSync(configOverridePath)) {
  const override = JSON.parse(readFileSync(configOverridePath, 'utf8'))
  config = { ...defaultConfig, ...override }
}

// 任务文件 → 注入 state
if (taskFile) {
  const taskData = JSON.parse(readFileSync(resolve(taskFile), 'utf8'))
  const storePath = config.session.storePath
  mkdirSync(storePath, { recursive: true })
  const stateFile = `${storePath}/state.json`
  if (!existsSync(stateFile)) {
    const tasks: Task[] = (taskData.tasks ?? []).map((t: Record<string, unknown>, i: number) => ({
      id: String(t.id ?? `task-${i + 1}`),
      description: String(t.description ?? t.title ?? JSON.stringify(t)),
      status: (t.status as Task['status']) ?? 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }))
    // 世代 = 归档代数 + 1（与前代知识传承对齐）
    const archiveDir = `${storePath}/archive`
    let generation = 1
    if (existsSync(archiveDir)) {
      const gens = readdirSync(archiveDir).filter((d) => statSync(join(archiveDir, d)).isDirectory())
      generation = gens.length + 1
    }
    const initial = {
      version: 1,
      generation,
      goal: taskData.goal ?? taskData.description ?? '未指定目标',
      tasks,
      progress: 0,
      startedAt: new Date().toISOString(),
      lastWakeAt: new Date().toISOString(),
      consecutiveFailures: 0,
      done: false,
    }
    writeFileSync(stateFile, JSON.stringify(initial, null, 2))
    console.log(`[init] 任务文件已注入: ${tasks.length} 个任务, 世代: ${generation}, 目标: ${initial.goal}`)
  }
}

// ── 装配 App（插件加载顺序 = 依赖顺序：管理层 → 驱动层 → 推理层 → 进化层）──
class App extends Context {}

const app = new App()

app.plugin(SessionPlugin, config.session)
app.plugin(LifecyclePlugin, config.lifecycle)
app.plugin(TimerPlugin, config.timer)
app.plugin(EventPlugin, config.event)
app.plugin(LLMPlugin, config.llm)
app.plugin(ToolsPlugin, config.tools)
app.plugin(CreativePlugin, config.creative)
app.plugin(AgentLoopPlugin, config.loop)
app.plugin(JudgePlugin, config.judge)
app.plugin(SelfHealPlugin, config.selfHeal)

await app.start()

// 启动后注册业务工具（需要 tools + session 服务）
const tools = app.get('tools') as ToolsService
const session = app.get('session') as SessionService
registerBusinessTools(tools, session)

console.log('[boot] SelfAgent 已启动 — 十插件架构在线')
console.log(`[boot] 状态目录: ${session.storePath}, 世代: ${session.getState().generation}`)

// ── 终止监听：收到 lifecycle/terminated → 进程退出 ──
let terminated = false
app.on('lifecycle/terminated', (payload: { reason: string; exitCode: number; archivePath: string }) => {
  if (terminated) return
  terminated = true
  console.log(`[lifecycle] 终止: ${payload.reason}, 归档: ${payload.archivePath}`)
  void app.stop().then(() => {
    console.log(`[exit] code=${payload.exitCode}`)
    process.exit(payload.exitCode)
  })
})

// ── 运行模式 ──
if (onceMode) {
  // 单周期模式：立即跑一个唤醒周期（测试/演示用）
  console.log('[run] 单周期模式 — 立即执行一次推理循环')
  const loop = app.get('loop') as LoopService
  await loop.runCycle('timer', 'once-mode')
  console.log('[run] 单周期完成')
  if (!terminated) {
    await app.stop()
    process.exit(0)
  }
} else if (daemonMode) {
  console.log('[run] 常驻模式 — Timer 心跳已启动，Ctrl+C 退出')
} else if (taskFile) {
  // 任务文件模式：驱动到完成（轮询 state.done）
  console.log('[run] 任务模式 — 驱动直到任务完成')
  const loop = app.get('loop') as LoopService
  const lifecycle = app.get('lifecycle') as LifecycleService | undefined
  let cycles = 0
  const maxCycles = 20
  while (cycles < maxCycles && !session.getState().done && !terminated) {
    await loop.runCycle('timer', `task-cycle-${++cycles}`)
    console.log(`[run] 第 ${cycles} 轮完成, done=${session.getState().done}`)
  }
  if (!terminated) {
    // 走完整生命周期：归档 + 终态报告（而不是裸退出）
    if (lifecycle) {
      if (session.getState().done) {
        console.log('[run] 任务完成 — 触发优雅终止')
        await lifecycle.terminate('task_complete', 0, 'task mode: all done')
      } else {
        console.log(`[run] 达到最大轮数 ${maxCycles}，任务未完成 — 归档退出`)
        await lifecycle.terminate('external_kill', 1, `max cycles ${maxCycles} reached`)
      }
    } else {
      if (session.getState().done) {
        console.log('[run] 任务完成')
      } else {
        console.log(`[run] 达到最大轮数 ${maxCycles}，任务未完成`)
      }
      await app.stop()
      process.exit(session.getState().done ? 0 : 1)
    }
  }
}
