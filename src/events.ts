// 事件总线常量 —— 十插件协作的事件契约
// 所有插件通过发布/订阅这些事件通信，不直接互相调用

export const Events = {
  // 驱动层 → 推理层
  WAKE: 'agent/wake',
  FEEDBACK: 'agent/feedback',

  // 推理层 → 进化层
  DONE: 'agent/done',

  // 进化层内部
  JUDGE_REPORT: 'judge/report',
  HEAL_ACTION: 'heal/action',
  RUNTIME_MODIFIED: 'runtime/modified',

  // 管理层 → 全局
  TERMINATE: 'lifecycle/terminate',

  // 工具执行流水线（Tool Registry 发布，Judge 可订阅实时监控）
  TOOL_EXECUTED: 'tool/executed',
} as const

// 服务名常量 —— Cordis 服务注入契约
export const Services = {
  SESSION: 'session',
  LIFECYCLE: 'lifecycle',
  TIMER: 'timer',
  EVENT: 'event',
  LLM: 'llm',
  TOOLS: 'tools',
  LOOP: 'loop',
  JUDGE: 'judge',
  SELF_HEAL: 'self-heal',
  CREATIVE: 'creative',
} as const
