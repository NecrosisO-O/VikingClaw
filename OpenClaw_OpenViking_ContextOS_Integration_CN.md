# OpenClaw x OpenViking 整合架构（当前实现）

更新日期：2026-02-27

## 1. 范围说明

本文描述的是本仓库里已经落地的真实架构。

有一个关键事实：

1. OpenClaw 支持多种记忆后端（`builtin`、`qmd`、`openviking`）。
2. 默认后端仍然是 `builtin`。
3. 只有在配置 `memory.backend=openviking` 时，下面这套 OpenViking 架构才会生效。

主要依据：`openclaw-2026.2.19/src/memory/backend-config.ts`

## 2. 运行时拓扑

```text
用户 / 渠道 / CLI
        |
        v
OpenClaw Gateway（运行时编排、工具生命周期、Agent 生命周期）
        |
        +--> OpenVikingMemoryManager（读路径）
        |       |
        |       +--> search/search + content/read/overview/abstract
        |       +--> 策略规划（memory/resource/skill 优先级）
        |       +--> 可选 relation 扩展（类似 BFS）
        |
        +--> OpenViking Bridge + Outbox（写路径）
                |
                +--> 会话绑定
                +--> 批量事件写入
                +--> async/sync commit 触发
                +--> outbox 持久化重试与刷盘
```

核心实现文件：

- `openclaw-2026.2.19/src/memory/openviking/manager.ts`
- `openclaw-2026.2.19/src/memory/openviking/bridge.ts`
- `openclaw-2026.2.19/src/memory/openviking/outbox.ts`
- `openclaw-2026.2.19/src/memory/openviking/client.ts`

## 3. 后端选择与默认值

### 3.1 后端选择

OpenClaw 会按配置选择并实例化对应后端：

- `builtin`：本地内置记忆路径
- `qmd`：Qdrant + 模型增强路径
- `openviking`：OpenViking 服务路径（本地或远端）

### 3.2 OpenViking 当前默认参数

在启用 OpenViking 且未手动覆盖配置时：

- Endpoint：`http://127.0.0.1:9432`
- 检索策略：`auto`
- 读取层：`progressive`
- 检索预算：
  - `maxEntries=6`
  - `maxSnippetChars=560`
  - `maxInjectedChars=3200`
- Relation 扩展：`false`（默认关闭）
- Outbox 刷新间隔：`2000ms`
- Commit 触发：
  - 每 `24` 条消息
  - 每 `12` 分钟
- FS 写入策略：默认禁用

依据：`openclaw-2026.2.19/src/memory/backend-config.ts`

## 4. 会话身份模型

OpenClaw 的会话记录中包含 OpenViking 关联元信息：

- `openvikingSessionId`
- `lastCommitAt`
- `lastSyncedSeq`

依据：`openclaw-2026.2.19/src/config/sessions/types.ts`

行为流程：

1. 首次写入时，先确保 OpenClaw 会话与 OpenViking 会话建立映射。
2. 映射信息写回 OpenClaw 会话存储。
3. 后续写入与提交复用该 OpenViking 会话 id。

依据：`openclaw-2026.2.19/src/memory/openviking/bridge.ts`

## 5. 读路径设计

读路径由 `OpenVikingMemoryManager` 实现。

### 5.1 检索策略规划

管理器会综合以下信号：

- 语义检索结果
- 规划信号（`query_plan`、`query_results`）
- 查询词汇信号
- 是否有 session

再决定 `memory/resource/skill` 的检索优先级。

依据：`openclaw-2026.2.19/src/memory/openviking/manager.ts`

### 5.2 分层读取与预算截断

支持 `l0`、`l1`、`l2`、`progressive` 分层读取，并在注入前按预算截断。

### 5.3 Relation 扩展（可选）

开启后可按关系图扩展相邻候选，并按优先级动态增配预算。

### 5.4 空命中兜底

主检索候选为空时，可回退到 `search/find` 路径。

## 6. 写路径设计

写路径围绕 OpenViking bridge 与 outbox 队列构建。

主流程：

1. 把 OpenClaw 的事件/消息/工具输出转换为 OpenViking 事件。
2. 写入本地 outbox。
3. 后台批量 flush 到 OpenViking：
   - `/api/v1/sessions/{sessionId}/events/batch`
4. 按生命周期和周期规则触发 commit。

关键函数：

- `ensureOpenVikingSessionLink(...)`
- `enqueueOpenVikingMessage(...)`
- `enqueueOpenVikingCommit(...)`
- `getOpenVikingOutboxStats(...)`

依据文件：

- `openclaw-2026.2.19/src/memory/openviking/bridge.ts`
- `openclaw-2026.2.19/src/memory/openviking/client.ts`

一致性模型：

- commit 支持 `sync` 或 `async`。
- 默认 `async`，所以持久化是“最终一致”，不是“严格实时一致”。

## 7. 运维能力面（CLI）

OpenClaw CLI 已暴露主要 OpenViking 操作：

1. 检索诊断
   - `memory search-trace`
   - `memory find`
   - `memory grep`
   - `memory glob`
2. 会话生命周期
   - `memory sessions-list/get/delete/extract/message`
3. Pack 迁移
   - `memory pack-export`
   - `memory pack-import`
4. 文件系统
   - `memory fs-ls/tree/stat/mkdir/rm/mv`
5. 关系操作
   - `memory relations/relation-link/relation-unlink`

依据：`openclaw-2026.2.19/src/cli/memory-cli.ts`

## 8. 安全与闸门

可写 FS 操作受策略闸门保护。

需要同时满足：

1. `fsWrite.enabled=true`
2. 必须配置 `allowUriPrefixes`
3. 强制执行 `denyUriPrefixes`
4. 强制执行 `protectedUris`
5. 递归删除还需：
   - 策略允许（`allowRecursiveRm=true`）
   - CLI 显式确认（`--yes`）

依据：

- `openclaw-2026.2.19/src/memory/openviking/fs-relations.ts`
- `openclaw-2026.2.19/src/config/types.memory.ts`

## 9. 可观测性

目前有两条主要观测面：

1. `openclaw status`
   - 策略/读取层摘要
   - 预算丢弃计数
   - commit 触发信息
   - lag/periodic 信号
2. `openclaw memory search-trace`
   - 最近一次检索策略与候选选择快照

依据：

- `openclaw-2026.2.19/src/commands/status.command.ts`
- `openclaw-2026.2.19/src/cli/memory-cli.ts`

## 10. 当前架构边界

当前实现有意保留这些边界：

1. 还没有图形化检索轨迹 UI（当前是 CLI/JSON 诊断）。
2. 默认 async commit 下，写入持久化是最终一致。
3. Relation 扩展默认关闭，偏保守策略。
4. OpenViking 是记忆后端路径，不替代 OpenClaw 的 Agent 编排角色。

这套架构对“单人长期助手”是务实平衡：记忆能力和可观测性显著增强，同时风险边界可控。
