// ═══ Cordis 事件类型增强 —— 声明合并扩展 Events 表 ═══
// Cordis 3.x 的事件名必须在 Events 接口里声明才能通过类型检查。
// 本文件是全局声明合并，所有插件的 ctx.on/ctx.emit 据此获得类型安全。

import type { WakePayload, FeedbackPayload, DonePayload, JudgeReportPayload, HealActionPayload, RuntimeModifiedPayload, TerminatePayload, ToolCallRecord } from './types.js'

declare module '@cordisjs/core' {
  interface Events<C> {
    // 驱动层 → 推理层
    'agent/wake'(payload: WakePayload): void
    'agent/feedback'(payload: FeedbackPayload): void

    // 推理层 → 进化层
    'agent/done'(payload: DonePayload): void

    // 进化层内部
    'judge/report'(payload: JudgeReportPayload): void
    'heal/action'(payload: HealActionPayload): void
    'runtime/modified'(payload: RuntimeModifiedPayload): void

    // 管理层 → 全局
    'lifecycle/terminate'(payload: TerminatePayload): void
    'lifecycle/terminated'(payload: { reason: string; exitCode: number; archivePath: string; report: Record<string, unknown> }): void

    // 工具执行流水线
    'tool/executed'(payload: ToolCallRecord): void

    // 内部诊断事件
    'timer/adjusted'(payload: { interval: string; reason: string }): void
    'session/ready'(payload: string): void
    'session/archived'(payload: string): void
    'event/webhook-listening'(payload: { port: number; path: string }): void
  }
}
