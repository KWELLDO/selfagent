// ═══ LLM Adapter Plugin —— 模型接入 ═══
// 统一 chat(messages, tools) 接口，OpenAI 兼容协议，支持 fallback + 成本统计

import type { Context } from '@cordisjs/core'
import type { LLMConfig, ChatMessage, ToolSchema, ChatResult, ToolCallRequest } from '../types.js'

export interface LLMService {
  chat(messages: ChatMessage[], tools?: ToolSchema[]): Promise<ChatResult>
  getUsage(): { totalTokens: number; totalCalls: number }
  setModel(model: string): void
}

interface ProviderEndpoint {
  baseUrl: string
  apiKeyEnv: string
}

const PROVIDERS: Record<string, ProviderEndpoint> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
}

export const LLMPlugin = (ctx: Context, config: LLMConfig): void => {
  let totalTokens = 0
  let totalCalls = 0
  let currentModel = config.model

  const callProvider = async (
    provider: string,
    model: string,
    messages: ChatMessage[],
    tools?: ToolSchema[],
  ): Promise<ChatResult> => {
    const endpoint = PROVIDERS[provider]
    if (!endpoint) throw new Error(`unknown provider: ${provider}`)
    const apiKey = process.env[endpoint.apiKeyEnv]
    if (!apiKey) throw new Error(`missing env ${endpoint.apiKeyEnv}`)

    const body: Record<string, unknown> = {
      model,
      // 深拷贝后改写，避免就地 mutate 调用方的 messages（会导致第二轮请求字段丢失）
      messages: messages.map((msg) => {
        if (msg.role === 'assistant' && msg.tool_calls?.length) {
          return {
            ...msg,
            content: msg.content || null,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              type: 'function' as const,
              function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
            })),
          }
        }
        return { ...msg }
      }),
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    }
    if (tools?.length) body.tools = tools
    if (process.env.SELFAGENT_DEBUG_LLM) {
      console.error('[llm-debug] request messages:', JSON.stringify(body.messages, null, 2).slice(0, 3000))
    }

    const started = Date.now()
    const resp = await fetch(`${endpoint.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })

    if (!resp.ok) {
      const text = await resp.text()
      throw new Error(`LLM ${resp.status}: ${text.slice(0, 200)}`)
    }

    const data = await resp.json() as {
      choices: { message: { content: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[]
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      model: string
    }

    const msg = data.choices?.[0]?.message
    const toolCalls: ToolCallRequest[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: (() => { try { return JSON.parse(tc.function.arguments) } catch { return {} } })(),
    }))

    const usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    }
    totalTokens += usage.totalTokens
    totalCalls++

    return {
      content: msg?.content ?? '',
      toolCalls,
      usage,
      model: data.model,
      latencyMs: Date.now() - started,
    }
  }

  const service: LLMService = {
    chat: async (messages, tools) => {
      const maxRetries = config.retry.maxRetries
      let lastError: Error | null = null

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await callProvider(config.provider, currentModel, messages, tools)
        } catch (err) {
          lastError = err as Error
          // 预算 80% 触发 fallback 模型
          const fallback = config.fallback
          if (fallback && currentModel !== fallback.model) {
            try {
              return await callProvider(fallback.provider, fallback.model, messages, tools)
            } catch { /* fallback 也失败，继续重试逻辑 */ }
          }
          if (attempt < maxRetries) {
            const backoff = config.retry.backoff === 'exponential' ? 1000 * 2 ** attempt : 1000
            await new Promise((r) => setTimeout(r, backoff))
          }
        }
      }
      throw lastError ?? new Error('LLM call failed')
    },
    getUsage: () => ({ totalTokens, totalCalls }),
    setModel: (model) => { currentModel = model },
  }

  ctx.set('llm', service)
}
