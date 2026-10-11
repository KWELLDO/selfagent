# SelfAgent — 云端自我运行 Agent

基于 [Cordis](https://github.com/cordiverse/cordis) 插件框架的自主 Agent 系统。定时唤醒 + 反馈触发 + LLM 推理循环，叠加独立评估（Judge）、自我改进（Self-Heal）、运行时自修改（Creative Mode）和生命周期管理（Lifecycle），形成十插件协作的完整架构。

> 设计哲学：**Agent 本身是健忘的，但环境替它记住一切；Agent 可以修改自己的运行方式，但不能修改评估自己的机制；Agent 完成任务后优雅归档自毁，知识传承给下一代。**

## 特性

- **十插件架构**：驱动层（Timer/Event）、推理层（Loop/LLM/Tools）、进化层（Judge/Self-Heal/Creative）、管理层（Session/Lifecycle），全栈可替换
- **双驱动模型**：cron 定时唤醒 + webhook/文件反馈触发，反馈优先
- **两层错误定义**：软件工程层（业务正确性）+ 运维工程层（可行性与稳定性）
- **自我进化闭环**：Judge 独立评估 → Self-Heal 自动修复 → Creative Mode 运行时修改 → 验证后 commit，失败则回滚
- **优雅生命周期**：任务完成 / 不可恢复错误 / 外部终止 → 归档 → 自毁 → 知识传承给下一代 Agent
- **三层记忆**：工作记忆（单次唤醒）、短期记忆（跨唤醒）、长期记忆（跨任务）
- **安全边界**：Agent 运行时可修改 llm/timer/loop 配置，但**永远不能动 judge/self-heal/lifecycle**

## 快速开始

### 环境要求

- Node.js ≥ 20（推荐 22 LTS）
- pnpm
- 一个 OpenAI 兼容的 LLM API key（默认 DeepSeek，可扩展）

### 安装

```bash
git clone <repo-url>
cd selfagent
pnpm install
pnpm build
```

### 配置 API Key

```bash
export DEEPSEEK_API_KEY=sk-xxxx    # 或 OPENAI_API_KEY（改 src/index.ts 里 defaultConfig.llm）
```

### 跑一个任务（最简单的方式）

```bash
node dist/index.js --task examples/daily-note/task.json
```

任务文件是一个 JSON：

```json
{
  "goal": "你的整体目标",
  "tasks": [
    { "id": "t1", "description": "具体做什么（Agent 能用的工具见下文）" },
    { "id": "t2", "description": "再做什么" }
  ]
}
```

Agent 会自己：读目标 → 调工具干活 → 标记任务 done → 全部完成后自动归档自毁。

### 常驻模式（自我运行的本体）

```bash
node dist/index.js --daemon
```

Timer 默认每 5 分钟唤醒一次，Agent 从 `state/state.json` 读状态继续工作。配合外部触发：

- **Webhook**：POST 到 `localhost:3000/hook`（幂等去重，可配 HMAC 校验）
- **文件 Watcher**：往 inbox 目录丢文件即触发一轮

### Agent 能用的工具

你在任务 description 里描述的事，Agent 用这些工具完成：

| 工具 | 能力 | 约束 |
|:---|:---|:---|
| `http-get` | 抓取网页/API（只读） | 30s 超时 |
| `fs-write` / `fs-read` | 读写文件 | 沙箱内 `state/sandbox/` |
| `memory-read` / `memory-write` | 读写短期/长期记忆 | — |
| `task-update` | 更新任务状态 | — |
| `finish` | 声明全部完成 | 触发归档自毁 |
| `inspect-runtime` / `read-config` / `read-heal-log` / `read-judge-report` | 运行时自省 | — |
| `patch-config` / `commit-change` / `rollback-change` | 运行时自修改 | 试验-提交分离 |

description 写得越具体，产出越靠谱：“抓取 X 网页提取价格，写入 notes/price.md” 远胜于 “调研一下”。

## 查看它干了什么

| 看什么 | 路径 |
|:---|:---|
| 当前任务状态 | `state/state.json` |
| 执行日志（追加式） | `state/progress.log` |
| Agent 写的产出 | `state/sandbox/` |
| Judge 评估报告 | `state/judge/reports/` |
| Self-Heal 操作日志 | `state/heal-log.jsonl` |
| 历史归档（含记忆） | `state/archive/{时间戳}/` |

## 架构总览

```
┌─ 驱动层 ──────────────────────────────┐
│  Timer（心跳）  Event（耳朵）            │
└──────────────┬────────────────────────┘
               │ agent/wake · agent/feedback
┌──────────────▼────────────────────────┐
│ 推理层                                 │
│  Agent Loop（编排） LLM（接入） Tools（执行）│
└──────────────┬────────────────────────┘
               │ agent/done
┌──────────────▼────────────────────────┐
│ 进化层                                 │
│  Judge（评估） → Self-Heal（修复）        │
│       ↓                                │
│  Creative Mode（运行时自省/自修改）        │
└──────────────┬────────────────────────┘
               │ runtime/modified（下一轮生效）
┌──────────────▼────────────────────────┐
│ 管理层                                 │
│  Session（状态+三层记忆） Lifecycle（生老病死）│
└───────────────────────────────────────┘
```

插件间**只通过事件总线通信**，不直接互相调用——换掉任何一个插件，只要保证订阅/发布相同的事件，其他组件零改动。

### 事件契约

| 事件 | 发布方 → 订阅方 | 载荷 |
|:---|:---|:---|
| `agent/wake` | Timer → Loop | 唤醒原因+时间戳 |
| `agent/feedback` | Event → Loop | 反馈内容（幂等去重后） |
| `agent/done` | Loop → Judge/Lifecycle | 步数/工具数/token/成败 |
| `judge/report` | Judge → Self-Heal | 两层评估+建议 |
| `heal/action` | Self-Heal → Creative | 修复动作 |
| `runtime/modified` | Creative → Loop | 修改内容（下轮生效） |
| `lifecycle/terminate` | Loop/Self-Heal → Lifecycle | 终止原因+退出码 |

## 自我进化示例

**运维层：Token 预算告急**
```
Judge 检测到 token 用量 > 60% 预算
  → Self-Heal 选策略：切轻量模型 + 降唤醒频率
  → patch-config(llm, model=deepseek-chat-lite) + patch-config(timer, interval=15m)
  → 下轮生效，消耗速率下降
  → Judge 确认回归安全区 → commit-change 持久化（写 state/config/patches.json）
  → 若未生效 → rollback-change 回滚，换策略
```

**软件层：工具连续失败**
```
fs-write 连续失败 → Judge 生成报告（tool_failures x3, permission denied）
  → Self-Heal 记录 lesson 到长期记忆（避免模式）
  → 下轮 prompt 注入教训 → 成功率恢复
  → qualityScore ≥ 0.8 → 标记 lesson 已验证，供后代 Agent 加载
```

## 知识传承（Agent 转世）

```
Agent-v1 运行 → 自我改进 → 任务完成 → 归档 → 自毁
                                            ↓
Agent-v2 启动 ← 加载前代 lessons.json ← archive/latest/
```

世代号 = 归档代数 + 1。每代从零开始，但站在前代肩膀上。

## 部署

### systemd 常驻（Linux）

```ini
[Unit]
Description=SelfAgent
After=network.target

[Service]
WorkingDirectory=/opt/selfagent
EnvironmentFile=/opt/selfagent/.env
ExecStart=/opt/node22/bin/node dist/index.js --daemon
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

`.env` 里放 `DEEPSEEK_API_KEY=sk-xxx`（chmod 600）。

### armv7 小主机

无原生依赖（纯 JS），直接 rsync 源码 + node_modules 即可运行，Node ≥ 20 就行。

## 项目结构

```
src/
├── index.ts              # 入口：装配十插件，三种运行模式
├── augment.ts            # Cordis 事件类型声明合并
├── types.ts              # 全部共享类型（契约层）
├── events.ts             # 事件/服务名常量
├── business-tools.ts     # 业务工具集（fs/http/memory/task/finish）
└── plugins/
    ├── session.ts        # 状态持久化 + 三层记忆 + 归档
    ├── timer.ts          # cron/interval 唤醒，静默期/冷却/自适应
    ├── event.ts          # webhook + 文件 watcher，幂等去重
    ├── loop.ts           # 推理循环（Ralph Loop 模式）
    ├── llm.ts            # OpenAI 兼容接入，fallback + 重试
    ├── tools.ts          # 工具注册 + 权限/沙箱/超时流水线
    ├── judge.ts          # 两层评估体系
    ├── self-heal.ts      # 策略表 + 尝试上限 + 验证闭环
    ├── creative.ts       # 运行时自省/自修改 + 安全边界
    └── lifecycle.ts      # 归档/自毁/知识传承
prompts/base.md           # 系统提示词
examples/                 # 任务文件示例
```

## 欢迎 PR 🎉

这是一个设计驱动的极简实现，很多地方可以做得更好：

**想参与的方向**
- 新的业务工具（搜索、数据库、代码执行沙箱）
- 新的 LLM provider 适配（`src/plugins/llm.ts` 的 `PROVIDERS` 表加一行即可）
- Judge 的检测项扩充（幻觉检测、更深的目标漂移分析）
- Self-Heal 策略表扩充（`src/plugins/self-heal.ts` 的 `strategies`）
- 部署方案（Docker、k8s Job、serverless）
- 文档、示例任务、测试

**提交约定**
- 一个 PR 做一件事
- 改插件前先读对应插件的头部注释（设计取舍都写在里面）
- 涉及插件间契约（事件/服务）的改动，请在 PR 描述里说明影响面
- 运行 `pnpm build` 确保编译通过

提 issue 讨论想法也非常欢迎——尤其是「你的 Agent 在什么场景下卡住了」。

## License

MIT
