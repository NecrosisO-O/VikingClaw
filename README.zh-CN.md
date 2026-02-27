# OpenClaw x OpenViking Integration

[English README](./README.md)

一个面向“单人长期助手”场景的集成项目：

- **OpenClaw** 负责对话入口、工具执行和多渠道接入。
- **OpenViking** 负责长期记忆、上下文检索和会话沉淀。

本仓库目标不是简单拼装两个项目，而是让二者在真实使用路径中协同工作：
对话可持续、记忆可治理、检索可解释、迁移可操作。

## AI 辅助开发声明 / AI Assistance Notice

- 本仓库包含来自上游项目的代码快照（`openclaw-2026.2.19/`、`OpenViking-0.1.17/`），这些上游代码并非由本仓库单独生成。
- 本仓库中的整合改造、配置调整与文档更新过程使用了 AI 编程助手进行辅助生成与修改。

## 项目定位

这个项目适合以下场景：

1. 你希望助手是“长期助手”，而不是只看当前上下文的单轮问答器。
2. 你希望助手的知识来源不仅是会话历史，还包括资源文件与技能内容。
3. 你希望记忆系统可观测、可回溯、可迁移，而不只是黑盒缓存。

## 核心能力

### 1. 统一上下文管理（memory/resource/skill）

OpenViking 以文件系统语义统一管理上下文来源，OpenClaw 在检索时可同时利用：

- 记忆片段
- 资源文档
- 技能相关内容

### 2. 分层检索与注入预算

支持分层读取（`l0/l1/l2/progressive`）与注入预算控制，目标是：

- 尽量保留相关信息
- 避免上下文注入过载
- 提升回答稳定性与可控性

### 3. 自动会话沉淀与异步提交

消息和工具事件进入 outbox 后异步提交到 OpenViking，会话记忆可以长期积累并支持后续检索。

### 4. 检索可观测

通过 `memory search-trace` 与 `status` 信号可查看：

- 检索策略与分层决策
- 预算命中和裁剪情况
- 时效相关信号（flush/commit/lag）

### 5. 可治理能力（Session/FS/Relation/Pack）

通过 CLI 可直接进行：

- 会话查询、补消息、删除、提取
- 文件系统读取与受控写入
- 关系链接管理
- pack 导入导出（迁移/备份）

## 仓库结构

```text
.
├── openclaw-2026.2.19/      # OpenClaw 集成代码（主要开发目录）
├── OpenViking-0.1.17/       # OpenViking 源码（服务端/联调）
├── README.md                # 英文主文档（发布版）
├── README.zh-CN.md          # 中文文档
├── LICENSE                  # 根目录许可说明（聚合仓库）
└── NOTICE                   # 第三方组件归属与许可说明
```

## 架构概览

```text
User / Channel / CLI
        |
        v
  OpenClaw Gateway
        |
        +--> LLM Answer + Tool Execution
        |
        +--> OpenViking Memory Backend
                  |
                  +--> Search/Find/Grep/Glob   (读路径)
                  +--> Event Outbox + Commit   (写路径)
                  +--> Session/FS/Relation/Pack
```

读路径与写路径分离，目标是保证主对话体验与长期记忆沉淀同时成立。

## 环境要求

建议环境：

- Node.js `>= 22.12.0`
- pnpm `>= 10`
- Python `3.11 - 3.13`
- Linux / macOS（Windows 建议 WSL2）

## 快速开始（本地最小可用）

### 1) 安装 OpenViking

```bash
cd OpenViking-0.1.17
python3 -m venv .venv
source .venv/bin/activate
pip install -U pip setuptools wheel
pip install -e .[test]
```

### 2) 配置 OpenViking（`~/.openviking/ov.conf`）

```json
{
  "embedding": {
    "dense": {
      "provider": "volcengine",
      "api_key": "YOUR_API_KEY",
      "model": "doubao-embedding-vision-250615",
      "dimension": 1024,
      "input": "multimodal"
    }
  },
  "vlm": {
    "provider": "volcengine",
    "api_key": "YOUR_API_KEY",
    "model": "doubao-seed-1-8-251228"
  },
  "storage": {
    "agfs": { "backend": "local", "path": "./data" },
    "vectordb": { "backend": "local", "path": "./data" }
  },
  "server": {
    "host": "127.0.0.1",
    "port": 9432
  }
}
```

启动：

```bash
python -m openviking serve --config ~/.openviking/ov.conf --host 127.0.0.1 --port 9432
```

### 3) 安装 OpenClaw

```bash
cd openclaw-2026.2.19
pnpm install
pnpm ui:build
pnpm build
```

### 4) 配置 OpenClaw（`~/.openclaw/openclaw.json`）

```json5
{
  agent: {
    model: "anthropic/claude-opus-4-6",
  },
  memory: {
    backend: "openviking",
    openviking: {
      endpoint: "http://127.0.0.1:9432",
      dualWrite: true,
      commit: {
        mode: "async",
        triggers: {
          sessionEnd: true,
          reset: true,
          everyNMessages: 24,
          everyNMinutes: 12,
        },
      },
      outbox: {
        enabled: true,
        flushIntervalMs: 2000,
        maxBatchSize: 25,
        retryBaseMs: 1000,
        retryMaxMs: 60000,
      },
      search: {
        strategy: "auto",
        readLayer: "progressive",
        maxEntries: 6,
        maxSnippetChars: 560,
        maxInjectedChars: 3200,
        relationExpansion: false,
      },
    },
  },
}
```

### 5) 启动与验证

```bash
cd openclaw-2026.2.19
pnpm openclaw gateway --port 18789 --verbose
```

另开终端：

```bash
cd openclaw-2026.2.19
pnpm openclaw status
pnpm openclaw health
pnpm openclaw agent --message "请记住我偏好简洁回答"
```

## 常用命令

以下命令在 `openclaw-2026.2.19` 目录执行。

### 运行与状态

```bash
pnpm openclaw gateway --port 18789 --verbose
pnpm openclaw status
pnpm openclaw health
```

### 记忆检索与观测

```bash
pnpm openclaw memory status
pnpm openclaw memory search "部署记录"
pnpm openclaw memory search-trace
pnpm openclaw memory find "openclaw 配置文件位置" --limit 8
pnpm openclaw memory grep viking://resources "OPENAI_API_KEY" --case-insensitive
pnpm openclaw memory glob "**/*.md" --uri viking://resources
```

### 会话治理

```bash
pnpm openclaw memory sessions-list
pnpm openclaw memory sessions-get <session_id>
pnpm openclaw memory sessions-extract <session_id>
pnpm openclaw memory sessions-message <session_id> user "记住这个偏好"
pnpm openclaw memory sessions-delete <session_id>
```

### 资源与迁移

```bash
pnpm openclaw memory ingest-resource ./docs/runbook.md --wait
pnpm openclaw memory ingest-skill --data '{"name":"incident-playbook"}' --wait
pnpm openclaw memory pack-export viking://resources/docs /tmp/docs.ovpack
pnpm openclaw memory pack-import /tmp/docs.ovpack viking://resources --force
```

### FS 与关系（受策略控制）

```bash
pnpm openclaw memory fs-ls viking://resources --recursive
pnpm openclaw memory fs-tree viking://resources
pnpm openclaw memory fs-stat viking://resources/docs
pnpm openclaw memory fs-mkdir viking://resources/docs/new-folder
pnpm openclaw memory fs-rm viking://resources/docs/old-folder --yes
pnpm openclaw memory fs-mv viking://resources/docs/a viking://resources/docs/archive/a
pnpm openclaw memory relations viking://resources/docs/guide
pnpm openclaw memory relation-link viking://resources/docs/a viking://resources/docs/b --reason "same topic"
pnpm openclaw memory relation-unlink viking://resources/docs/a viking://resources/docs/b
```

## 部署建议（生产）

1. OpenViking 与 OpenClaw 使用独立进程守护（systemd/launchd/容器均可）。
2. OpenViking 数据目录使用稳定磁盘并纳入备份策略。
3. 跨主机部署时启用 OpenViking API Key，并在 OpenClaw 配置 `memory.openviking.apiKey`。
4. 将 pack 导出纳入周期备份，便于迁移与恢复。

## 关键行为说明

1. 记忆提交是异步机制，属于最终一致，不保证每次修改“立刻”在下一轮检索生效。
2. `search-trace` 当前提供文本/JSON 可观测能力，不是图形化轨迹界面。
3. 开启 FS 写操作前请先配置 allow/deny/protected 策略，避免误操作。

## 开发与升级策略

1. 本仓库为集成工作区，不是 OpenClaw 或 OpenViking 官方发行仓库。
2. 上游更新建议先在分支做差异评估，再迁移到集成分支。
3. 重点关注目录：
   - `openclaw-2026.2.19/src/memory/openviking/`
   - `openclaw-2026.2.19/src/memory/backend-config.ts`
   - `openclaw-2026.2.19/src/cli/memory-cli.ts`
   - `openclaw-2026.2.19/src/commands/status.command.ts`

## 许可与归属

- 根目录许可：见 `LICENSE`
- 第三方组件归属：见 `NOTICE`
- 上游组件保留原始许可：
  - `openclaw-2026.2.19/`：MIT
  - `OpenViking-0.1.17/`：Apache-2.0

## 上游链接

- OpenClaw GitHub: <https://github.com/openclaw/openclaw>
- OpenClaw Docs: <https://docs.openclaw.ai/start/getting-started>
- OpenViking GitHub: <https://github.com/volcengine/OpenViking>
- OpenViking Docs: <https://www.openviking.ai/docs>
