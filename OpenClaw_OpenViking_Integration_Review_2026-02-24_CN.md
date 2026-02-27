# OpenClaw x OpenViking 整合评估（当前状态）

更新日期：2026-02-27

## 1. 评估范围

本报告基于以下材料进行评估：

1. 当前仓库代码（`openclaw-2026.2.19/`、`OpenViking-0.1.17/`）。
2. 仓库内已存在的测试/门禁脚本与既有结论。
3. 本工作区之前阶段性复盘结果。

本次更新不新增测试执行，属于“结论整合与纠偏”版本。

## 2. 执行摘要

面向“单人长期助手”场景，这次整合已经达到可用且较深的程度：

1. OpenViking 的核心检索能力和会话记忆闭环已经接入。
2. OpenClaw 在启用 `memory.backend=openviking` 时，已经能把 OpenViking 当作高能力记忆后端。
3. OpenViking 主要操作面（search、sessions、pack、relations、fs）已在 OpenClaw CLI 暴露。
4. 安全闸门与可观测能力已落地。

当前主要差距不在“有没有接上”，而在“产品化深度”（例如图形化检索轨迹）。

## 3. 特性逐项对照

| OpenViking 设计能力 | 当前接入状态 | 证据锚点 | 置信度 |
|---|---|---|---|
| 统一上下文空间（memory/resource/skill） | 已接入 | `openclaw-2026.2.19/src/memory/openviking/manager.ts`, `openclaw-2026.2.19/src/memory/openviking/client.ts` | 高 |
| 分层检索（`l0/l1/l2/progressive`） | 已接入 | `openclaw-2026.2.19/src/memory/backend-config.ts`, `openclaw-2026.2.19/src/memory/openviking/manager.ts` | 高 |
| 策略化检索（planner + signals） | 已接入 | `openclaw-2026.2.19/src/memory/openviking/manager.ts` | 高 |
| `search/find/grep/glob` 能力面 | 已接入 | `openclaw-2026.2.19/src/memory/openviking/client.ts`, `openclaw-2026.2.19/src/cli/memory-cli.ts` | 高 |
| 会话生命周期与持久提交闭环 | 已接入 | `openclaw-2026.2.19/src/memory/openviking/bridge.ts`, `openclaw-2026.2.19/src/config/sessions/types.ts` | 高 |
| outbox 重试与异步持久化 | 已接入 | `openclaw-2026.2.19/src/memory/openviking/outbox.ts`, `openclaw-2026.2.19/src/memory/backend-config.ts` | 高 |
| 关系查询/建边/解绑 | 已接入 | `openclaw-2026.2.19/src/memory/openviking/client.ts`, `openclaw-2026.2.19/src/cli/memory-cli.ts` | 高 |
| pack 导入导出 | 已接入 | `openclaw-2026.2.19/src/memory/openviking/client.ts`, `openclaw-2026.2.19/src/cli/memory-cli.ts` | 高 |
| 受控 FS 写入（`mkdir/rm/mv`） | 已接入（策略闸门保护） | `openclaw-2026.2.19/src/memory/openviking/fs-relations.ts`, `openclaw-2026.2.19/src/config/types.memory.ts` | 高 |
| 检索轨迹可解释性 | 部分接入（CLI/JSON，有诊断；暂无 GUI） | `openclaw-2026.2.19/src/cli/memory-cli.ts`, `openclaw-2026.2.19/src/commands/status.command.ts` | 中高 |

## 4. 对真实使用体验的影响

### 4.1 带来的收益

1. 长期记忆能力更强：
   - 通过 session/event/commit 链路，记忆不再只停留在短期 prompt 拼接。
2. 上下文质量更可控：
   - 分层读取 + 预算限制，减少大段无关内容注入。
3. 问题定位更透明：
   - search-trace 和 status 信号能看到检索策略与丢弃原因。
4. 记忆数据可运维：
   - 支持会话提取、pack 迁移、relations、受控 FS 操作。

### 4.2 带来的代价

1. 写入默认最终一致（async）：
   - 最新消息可能有短暂延迟才出现在可检索结果里。
2. 记忆长期化副作用更明显：
   - 错误偏好或噪声记忆如果不治理，会持续影响后续回答。
3. 策略闸门会带来“看似阻塞”的体验：
   - FS 写命令在未配置 allow/deny/protected 前会被拒绝。
4. 轨迹体验还偏工程化：
   - 目前主要是文本/JSON 诊断，不是可视化调试界面。

## 5. 相比原生 OpenClaw 是否负优化

当前判断：**整体不是负优化**。

理由：

1. 增加了原生路径没有的长期记忆能力和运维控制面。
2. 不会替代或破坏 OpenClaw 的编排角色，更多是增强记忆后端能力。
3. 主要代价是治理和调参成本上升，不是用户价值本身倒退。

需要明确的前提：

- 如果不做记忆清理与策略治理，确实会出现“旧偏好强化”或“最新写入短时不可见”等体验问题。它们是可运营治理的问题，不是架构不可修复缺陷。

## 6. 既有测试与门禁覆盖

仓库内已经具备 OpenViking 专项门禁与 CI 接线：

1. 本地门禁脚本：
   - `openclaw-2026.2.19/scripts/openviking-phase7-gate.sh`
2. CI quick gate 触发：
   - `openclaw-2026.2.19/.github/workflows/ci.yml`

本报告引用的是既有测试资产与既有结论，不新增本轮测试执行。

## 7. 最终判断

截至 2026-02-27，这一整合已经不是“薄适配层”。

当前状态是：

1. OpenClaw 继续承担执行编排。
2. OpenViking 在启用时承担检索、记忆持久化和上下文操作系统能力。
3. 后续工作重点应放在运维治理体验和可视化产品化，而不是基础能力补齐。
