// ═══ Event Plugin —— 反馈触发（Agent 的耳朵）═══
// 监听外部事件源（webhook / 文件 watcher），幂等去重后发布 agent/feedback

import { createServer } from 'node:http'
import { watch } from 'node:fs'
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Context } from '@cordisjs/core'
import type { EventConfig, FeedbackPayload } from '../types.js'
import type { SessionService } from './session.js'

export interface EventService {
  pushFeedback(source: string, content: string, id?: string): boolean // 手动注入反馈（测试用）
  getReceivedCount(): number
}

export const EventPlugin = (ctx: Context, config: EventConfig): void => {
  const processedIds = new Set<string>()
  let receivedCount = 0
  let server: ReturnType<typeof createServer> | null = null
  let watcher: ReturnType<typeof watch> | null = null

  const publish = (payload: FeedbackPayload): void => {
    // 幂等：重复 feedbackId 静默丢弃
    if (processedIds.has(payload.feedbackId)) return
    processedIds.add(payload.feedbackId)
    receivedCount++
    // TTL 清理（简单实现：超过 ttl 条时清一半旧 ID）
    if (processedIds.size > 10000) {
      const arr = [...processedIds]
      arr.slice(0, 5000).forEach((id) => processedIds.delete(id))
    }
    ctx.emit('agent/feedback', payload)
  }

  const service: EventService = {
    pushFeedback: (source, content, id) => {
      const feedbackId = id ?? `fb-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      if (processedIds.has(feedbackId)) return false
      publish({ feedbackId, source, content, timestamp: new Date().toISOString() })
      return true
    },
    getReceivedCount: () => receivedCount,
  }
  ctx.set('event', service)

  // ── Webhook 源 ──
  if (config.webhook) {
    const { port, path, auth } = config.webhook
    server = createServer((req, res) => {
      if (req.url !== path || req.method !== 'POST') { res.writeHead(404).end(); return }
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        try {
          // HMAC 校验（配置了 auth 时）
          if (auth?.type === 'hmac') {
            const secret = process.env[auth.secretEnv]
            const sig = req.headers['x-signature'] as string
            if (secret && sig) {
              const expected = createHmac('sha256', secret).update(body).digest('hex')
              const a = Buffer.from(sig)
              const b = Buffer.from(expected)
              if (a.length !== b.length || !timingSafeEqual(a, b)) {
                res.writeHead(401).end('invalid signature')
                return
              }
            }
          }
          const data = JSON.parse(body)
          publish({
            feedbackId: data.feedbackId ?? data.id ?? `hook-${Date.now()}`,
            source: 'webhook',
            content: typeof data.content === 'string' ? data.content : JSON.stringify(data),
            timestamp: new Date().toISOString(),
          })
          res.writeHead(200).end('ok')
        } catch {
          res.writeHead(400).end('bad request')
        }
      })
    })
    server.listen(port, () => ctx.emit('event/webhook-listening', { port, path }))
  }

  // ── 文件 watcher 源 ──
  const watcherSource = config.sources?.find((s) => s.type === 'file-watcher')
  if (watcherSource?.path) {
    watcher = watch(watcherSource.path, (_evt, filename) => {
      if (!filename) return
      publish({
        feedbackId: `file-${filename}-${Date.now()}`,
        source: 'file-watcher',
        content: `file changed: ${filename}`,
        timestamp: new Date().toISOString(),
      })
    })
  }

  // 卸载时关服务（可逆）
  ctx.effect(() => () => {
    server?.close()
    watcher?.close()
  })
}
