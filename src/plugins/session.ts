// ═══ Session Plugin —— 状态持久化 + 三层记忆 ═══
// 所有插件共享的状态管理层。Agent 是健忘的，但环境不是。

import { mkdirSync, existsSync, readFileSync, writeFileSync, appendFileSync, readdirSync, cpSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import type { Context } from '@cordisjs/core'
import type { SessionConfig, AgentState, Task, MemoryEntry, LessonEntry, HealEntry, JudgeReportPayload } from '../types.js'
import { defaultState } from '../types.js'

export interface SessionService {
  getState(): AgentState
  setState(state: AgentState): void
  updateTask(id: string, patch: Partial<Task>): void
  appendLog(entry: Record<string, unknown>): void
  readMemory(scope: 'short' | 'long'): MemoryEntry[]
  writeMemory(scope: 'short' | 'long', entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'scope'>): MemoryEntry
  getLessons(): LessonEntry[]
  appendLesson(lesson: Omit<LessonEntry, 'id' | 'createdAt'>): void
  getHealLog(): HealEntry[]
  markHealVerified(timestamps: string[]): void
  appendHealLog(entry: HealEntry): void
  getJudgeReports(): JudgeReportPayload[]
  appendJudgeReport(report: JudgeReportPayload): void
  archive(): string
  storePath: string
}

let idCounter = 0
const genId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(idCounter++).toString(36)}`

export const SessionPlugin = (ctx: Context, config: SessionConfig): void => {
  const store = config.storePath
  const dirs = {
    root: store,
    memoryShort: join(store, 'memory', 'short-term'),
    memoryLong: join(store, 'memory', 'long-term'),
    judge: join(store, 'judge', 'reports'),
    archive: join(store, 'archive'),
    config: join(store, 'config'),
  }
  for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true })

  const stateFile = join(store, 'state.json')
  const progressLog = join(store, 'progress.log')
  const lessonsFile = join(store, 'memory', 'lessons.json')
  const healLogFile = join(store, 'heal-log.jsonl')

  // ── 状态读写（每次写盘，崩溃不丢）──
  const readJson = <T>(path: string, fallback: T): T => {
    if (!existsSync(path)) return fallback
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return fallback }
  }
  const writeJson = (path: string, data: unknown): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2))
  }

  const loadState = (): AgentState => {
    const saved = readJson<AgentState | null>(stateFile, null)
    if (saved) return saved
    // 新 Agent 出生：世代 = 归档代数 + 1（无论前代有没有 lessons，归档本身就代表一代）
    const gen = countGenerations(dirs.archive) + 1
    return defaultState('', gen)
  }

  let state = loadState()

  const service: SessionService = {
    storePath: store,

    getState: () => state,

    setState: (next) => {
      state = next
      writeJson(stateFile, state)
    },

    updateTask: (id, patch) => {
      const task = state.tasks.find((t) => t.id === id)
      if (!task) return
      Object.assign(task, patch, { updatedAt: new Date().toISOString() })
      state.progress = state.tasks.length
        ? state.tasks.filter((t: Task) => t.status === 'done').length / state.tasks.length
        : 0
      if (state.tasks.length && state.tasks.every((t) => t.status === 'done')) state.done = true
      writeJson(stateFile, state)
    },

    appendLog: (entry) => {
      appendFileSync(progressLog, JSON.stringify({ ...entry, ts: new Date().toISOString() }) + '\n')
    },

    readMemory: (scope) => {
      const dir = scope === 'short' ? dirs.memoryShort : dirs.memoryLong
      if (!existsSync(dir)) return []
      return readdirSync(dir)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<MemoryEntry>(join(dir, f), null as unknown as MemoryEntry))
        .filter(Boolean)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    },

    writeMemory: (scope, entry) => {
      const dir = scope === 'short' ? dirs.memoryShort : dirs.memoryLong
      const full: MemoryEntry = { ...entry, id: genId('mem'), createdAt: new Date().toISOString(), scope }
      writeJson(join(dir, `${full.id}.json`), full)
      return full
    },

    getLessons: () => readJson<LessonEntry[]>(lessonsFile, []),

    appendLesson: (lesson) => {
      const lessons = readJson<LessonEntry[]>(lessonsFile, [])
      lessons.push({ ...lesson, id: genId('lesson'), createdAt: new Date().toISOString() })
      writeJson(lessonsFile, lessons)
    },

    getHealLog: () => {
      if (!existsSync(healLogFile)) return []
      return readFileSync(healLogFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    },

    appendHealLog: (entry) => {
      appendFileSync(healLogFile, JSON.stringify(entry) + '\n')
    },

    markHealVerified: (timestamps) => {
      if (!existsSync(healLogFile)) return
      const lines = readFileSync(healLogFile, 'utf8').split('\n').filter(Boolean)
      const stampSet = new Set(timestamps)
      const updated = lines.map((line) => {
        try {
          const entry = JSON.parse(line) as HealEntry
          if (stampSet.has(entry.timestamp)) entry.verified = true
          return JSON.stringify(entry)
        } catch { return line }
      })
      writeFileSync(healLogFile, updated.join('\n') + '\n')
    },

    getJudgeReports: () => {
      if (!existsSync(dirs.judge)) return []
      return readdirSync(dirs.judge)
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<JudgeReportPayload>(join(dirs.judge, f), null as unknown as JudgeReportPayload))
        .filter(Boolean)
    },

    appendJudgeReport: (report) => {
      writeJson(join(dirs.judge, `report-${Date.now()}.json`), report)
    },

    archive: () => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const dest = join(dirs.archive, stamp)
      mkdirSync(dest, { recursive: true })
      if (existsSync(stateFile)) cpSync(stateFile, join(dest, 'state.json'))
      if (existsSync(progressLog)) cpSync(progressLog, join(dest, 'progress.log'))
      if (existsSync(join(store, 'memory'))) cpSync(join(store, 'memory'), join(dest, 'memory'), { recursive: true })
      if (existsSync(dirs.judge)) cpSync(dirs.judge, join(dest, 'judge'), { recursive: true })
      if (existsSync(healLogFile)) cpSync(healLogFile, join(dest, 'heal-log.jsonl'))
      ctx.emit('session/archived', dest)
      return dest
    },
  }

  ctx.set('session', service)
  ctx.emit('session/ready', store)
}

function countGenerations(archiveDir: string): number {
  if (!existsSync(archiveDir)) return 0
  return readdirSync(archiveDir).filter((f) => statSync(join(archiveDir, f)).isDirectory()).length
}
