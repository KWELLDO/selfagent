// 共享类型定义 —— 十插件架构的契约层

// ═══ 状态模型 ═══

export interface Task {
  id: string
  description: string
  status: 'pending' | 'active' | 'done' | 'failed'
  createdAt: string
  updatedAt: string
  result?: string
}

export interface AgentState {
  version: number
  generation: number          // 第几代 Agent
  goal: string                // 原始目标
  tasks: Task[]
  progress: number            // 0-1
  startedAt: string
  lastWakeAt: string
  consecutiveFailures: number
  done: boolean
}

export const defaultState = (goal: string, generation = 1): AgentState => ({
  version: 1,
  generation,
  goal,
  tasks: [],
  progress: 0,
  startedAt: new Date().toISOString(),
  lastWakeAt: new Date().toISOString(),
  consecutiveFailures: 0,
  done: false,
})

// ═══ 事件定义（事件总线契约）═══

export interface WakePayload {
  reason: 'timer' | 'feedback'
  timestamp: string
  detail?: string
}

export interface DonePayload {
  wakeId: string
  steps: number
  toolCalls: number
  tokensUsed: number
  success: boolean
  error?: string
}

export interface FeedbackPayload {
  feedbackId: string
  source: string
  content: string
  timestamp: string
}

export interface JudgeReportPayload {
  timestamp: string
  software: SoftwareAssessment
  operations: OperationsAssessment
  recommendations: Recommendation[]
  qualityScore: number
}

export interface SoftwareAssessment {
  toolFailures: ToolFailure[]
  goalDrift: 'none' | 'low' | 'medium' | 'high'
  loopDetected: boolean
  hallucinationRisk: 'none' | 'low' | 'medium' | 'high'
}

export interface ToolFailure {
  tool: string
  error: string
  count: number
  severity: 'low' | 'medium' | 'high'
}

export interface OperationsAssessment {
  tokenUsage: { used: number; budget: number; rate: 'normal' | 'high' | 'critical' }
  apiHealth: { successRate: number; avgLatencyMs: number }
  storageGrowth: 'stable' | 'growing' | 'overflow'
  pluginHealth: 'ok' | 'degraded' | 'failing'
  securityAlerts: string[]
}

export interface Recommendation {
  layer: 'software' | 'operations'
  action: string
  target?: string
  reason?: string
}

export interface HealActionPayload {
  issue: string
  layer: 'software' | 'operations'
  strategy: string
  tool: string
  args: Record<string, unknown>
}

export interface RuntimeModifiedPayload {
  target: string
  change: string
  reversible: boolean
}

export interface TerminatePayload {
  reason: 'task_complete' | 'unrecoverable_error' | 'external_kill'
  exitCode: number
  detail?: string
}

export interface ToolCallRecord {
  tool: string
  args: Record<string, unknown>
  result?: unknown
  error?: string
  latencyMs: number
  timestamp: string
  step: number
}

// ═══ 记忆模型 ═══

export interface MemoryEntry {
  id: string
  content: string
  tags: string[]
  createdAt: string
  scope: 'short' | 'long'
}

export interface LessonEntry {
  id: string
  issue: string
  fix: string
  effective: boolean
  createdAt: string
}

export interface HealEntry {
  timestamp: string
  issue: string
  layer: string
  action: string
  verified: boolean
}

// ═══ LLM 模型 ═══

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_call_id?: string
  tool_calls?: ToolCallRequest[]
}

export interface ToolCallRequest {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface ChatResult {
  content: string
  toolCalls: ToolCallRequest[]
  usage: { promptTokens: number; completionTokens: number; totalTokens: number }
  model: string
  latencyMs: number
}

// ═══ 配置模型 ═══

export interface PluginConfigs {
  session: SessionConfig
  lifecycle: LifecycleConfig
  timer: TimerConfig
  event: EventConfig
  llm: LLMConfig
  tools: ToolsConfig
  loop: LoopConfig
  judge: JudgeConfig
  selfHeal: SelfHealConfig
  creative: CreativeConfig
}

export interface SessionConfig {
  storePath: string
  memory: { shortTermTtl: string; longTermPersist: boolean }
}

export interface LifecycleConfig {
  archive: { path: string; compress: boolean; retention: string }
  webhook?: { onComplete?: string; onError?: string }
  inheritance: { loadLessons: boolean }
  maxLifespan: string
}

export interface TimerConfig {
  cron?: string
  interval?: string
  adaptive: boolean
  quietHours?: { start: string; end: string }
  cooldown: string
}

export interface EventConfig {
  webhook?: { port: number; path: string; auth?: { type: string; secretEnv: string } }
  idempotency: { store: string; ttl: string }
  sources: { type: string; path?: string }[]
}

export interface LLMConfig {
  provider: string
  model: string
  maxTokens: number
  temperature: number
  fallback?: { provider: string; model: string; trigger: string }
  retry: { maxRetries: number; backoff: string }
}

export interface ToolsConfig {
  sandbox: boolean
  approval: { autoApprove: string[]; requireApproval: string[] }
  timeout: string
}

export interface LoopConfig {
  maxSteps: number
  systemPromptPath?: string
  creativeMode: boolean
  feedbackPriority: boolean
  termination: { maxConsecutiveFailures: number; maxRuntime: string }
}

export interface JudgeConfig {
  evaluateEvery: number
  softwareChecks: { goalDriftInterval: number; loopThreshold: number }
  operationsChecks: { tokenBudget: number; storageLimit: string; apiSuccessThreshold: number }
}

export interface SelfHealConfig {
  maxRetriesPerIssue: number
  verifyRounds: number
  autoCommit: boolean
}

export interface CreativeConfig {
  runtimeForbidden: {
    uninstall: string[]
    patchConfig: string[]
    install: string[]
  }
  shutdownAllowed: { uninstall: string[]; archive: string[] }
}
