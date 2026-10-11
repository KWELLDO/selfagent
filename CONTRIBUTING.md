# 贡献指南

感谢关注 SelfAgent。这是一个设计驱动的项目——架构文档里的每个取舍都有原因，改动前请先理解再动手。

## 开始之前

1. 读 `README.md` 的架构总览，理解十插件分层和事件契约
2. 读你要改的插件文件**头部注释**——设计取舍都写在里面
3. 跑一遍快速开始，确保你的环境能端到端运行

## 开发流程

```bash
pnpm install
pnpm build          # tsc 编译到 dist/
node dist/index.js --task examples/daily-note/task.json   # 冒烟测试
```

修改 TypeScript 源码后重新 `pnpm build` 再运行（dist/ 是编译产物，不要手改）。

## 提交 PR

- 一个 PR 做一件事，PR 描述说清楚「为什么」而不只是「做了什么」
- `pnpm build` 必须通过（strict 模式）
- 涉及**插件间契约**的改动（事件名、服务接口、载荷结构），必须在 PR 描述里列出影响面——事件总线是全系统解耦的根基，破坏契约会连带其他插件
- 不引入新的运行时依赖，除非必要（本项目刻意保持纯 JS 无原生依赖，armv7 设备可直接运行）
- API key、state/、archive/ 等本地产物永远不进 git（已有 .gitignore）

## 受欢迎的贡献方向

| 方向 | 入口 |
|:---|:---|
| 新业务工具 | `src/business-tools.ts` 加 ToolDefinition |
| 新 LLM provider | `src/plugins/llm.ts` 的 PROVIDERS 表 |
| Judge 检测项 | `src/plugins/judge.ts` 的 assessSoftware/assessOperations |
| Self-Heal 策略 | `src/plugins/self-heal.ts` 的 strategies 表 |
| 部署方案 | Dockerfile / k8s / serverless |
| 示例任务 | `examples/` 下加目录 |

## 报告问题

提 issue 时请附：
- 运行模式（--task / --daemon / --once）
- `state/progress.log` 相关片段
- 期望行为 vs 实际行为

「Agent 在什么场景下卡住了」这类反馈价值最高——Self-Heal 的策略表就是靠真实失败场景长出来的。
