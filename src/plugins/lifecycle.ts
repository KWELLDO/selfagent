// ═══ Lifecycle Plugin —— 生命周期管理（出生证明和死亡证明）═══
// 管理 启动→运行→进化→终止→归档→自毁→知识传承 全流程
// 优雅终结：任务完成、不可恢复错误、外部终止均走归档+自毁
//
// 依赖注入说明：本插件依赖 session + timer 服务。Cordis 的 ctx.inject
// 保证依赖就绪后才执行回调，避免「插件加载顺序即依赖顺序」的隐式耦合。

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from '@cordisjs/core'
import type { LifecycleConfig, TerminatePayload, LessonEntry, Task } from '../types.js'
import type { SessionService } from './session.js'
import type { TimerService } from './timer.js'
import { Events } from '../events.js'

export interface LifecycleService {
  terminate(reason: TerminatePayload['reason'], exitCode: number, detail?: string): Promise<void>
  getStatus(): 'running' | 'terminating' | 'terminated'
}

export const LifecyclePlugin = (ctx: Context, config: LifecycleConfig): void => {
  ctx.inject(['session', 'timer'], (fork) => {
    let status: 'running' | 'terminating' | 'terminated' = 'running'
    const session = fork.get('session') as SessionService
    const timer = fork.get('timer') as TimerService
    const startedAt = Date.now()

    const generateFinalReport = (reason: TerminatePayload['reason']): Record<string, unknown> => {
      const state = session.getState()
      const healLog = session.getHealLog()
      return {
        terminatedAt: new Date().toISOString(),
        reason,
        lifespanMs: Date.now() - startedAt,
        generation: state.generation,
        goal: state.goal,
        tasksDone: state.tasks.filter((t: Task) => t.status === 'done').length,
        tasksTotal: state.tasks.length,
        healActions: healLog.length,
        lessonsLearned: session.getLessons().length,
      }
    }

    const service: LifecycleService = {
      terminate: async (reason, exitCode, detail) => {
        if (status !== 'running') return
        status = 'terminating'

        // 1. 暂停 Timer（停止后续唤醒）
        timer.setEnabled(false)

        // 2. 等待同步 handler 收尾（Judge 的 DONE 评估是异步触发但主体同步，
        //    给它一个事件循环的机会把报告写盘，避免归档拷到空 judge 目录）
        await new Promise((r) => setImmediate(r))

        // 3. 归档（Session.archive 拷贝全套状态）
        let archivePath = ''
        try {
          archivePath = session.archive()
        } catch (err) {
          session.appendLog({ type: 'archive-failed', error: String(err) })
        }

        // 4. 终态报告
        const report = generateFinalReport(reason)
        session.appendLog({ type: 'lifecycle-terminated', reason, detail, ...report })

        // 5. webhook 通知（可选）
        const webhookUrl = reason === 'unrecoverable_error' ? config.webhook?.onError : config.webhook?.onComplete
        if (webhookUrl) {
          try {
            await fetch(webhookUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ...report, archivePath }),
              signal: AbortSignal.timeout(10000),
            })
          } catch { /* webhook 失败不阻塞自毁 */ }
        }

        status = 'terminated'
        fork.emit('lifecycle/terminated', { reason, exitCode, archivePath, report })
      },

      getStatus: () => status,
    }

    // 任务完成检测：state.done 置位
    fork.on(Events.DONE, () => {
      const state = session.getState()
      if (state.done && status === 'running') {
        void service.terminate('task_complete', 0, 'all tasks done')
      }
    })

    // 不可恢复错误：Self-Heal 或 Loop 发布
    fork.on(Events.TERMINATE, (payload: TerminatePayload) => {
      if (status !== 'running') return
      void service.terminate(payload.reason, payload.exitCode, payload.detail)
    })

    // ── 启动时加载前代经验（知识传承）──
    if (config.inheritance.loadLessons) {
      try {
        const archiveDir = join(session.storePath, 'archive')
        if (existsSync(archiveDir)) {
          // 有归档目录 = 有前代；lessons.json 存在才加载经验内容
          const gens = readdirSync(archiveDir)
            .filter((d) => statSync(join(archiveDir, d)).isDirectory())
            .sort()
          const withLessons = gens.filter((d) => existsSync(join(archiveDir, d, 'memory', 'lessons.json')))
          if (withLessons.length) {
            const latest = withLessons.at(-1)!
            const lessons = JSON.parse(
              readFileSync(join(archiveDir, latest, 'memory', 'lessons.json'), 'utf8'),
            ) as LessonEntry[]
            let loaded = 0
            for (const lesson of lessons.filter((l: LessonEntry) => l.effective)) {
              session.appendLesson({ issue: lesson.issue, fix: lesson.fix, effective: true })
              loaded++
            }
            session.appendLog({ type: 'inheritance', loadedLessons: loaded, from: latest, generationsSeen: gens.length })
          } else if (gens.length) {
            session.appendLog({ type: 'inheritance', loadedLessons: 0, reason: 'no lessons in any generation', generationsSeen: gens.length })
          }
        }
      } catch (err) {
        session.appendLog({ type: 'inheritance-failed', error: String(err) })
      }
    }

    fork.set('lifecycle', service)
  })
}
