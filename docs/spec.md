# OpenClaw Session Core Rotation Plugin — Requirements Specification (v2)

> **目的**：本文档是一份完整、自包含的需求规格书。任何大模型（Claude、GPT、Gemini、Codex 等）拿到这份文档后，都应能理解需要实现什么、为什么要这样做、以及技术约束是什么。
>
> **v2 变更摘要**：基于可行性验证结果，精简为单一代码路径。砍掉 memoryFlush 自我总结、方案 A/B 分支、context% 阈值触发。改用 compaction 次数触发 + 结构化注入 + 崩溃安全状态机。

---

## 1. 背景与问题定义

### 1.1 什么是 OpenClaw？

[OpenClaw](https://github.com/openclaw/openclaw) 是一个开源的个人 AI 助手平台，支持多渠道（Telegram、Discord、Web 等）。它以后台 gateway 进程常驻运行，通过 session（对话历史）持续为用户服务。

### 1.2 当前架构的核心问题

OpenClaw 的 session 是**长期存活**的（从 gateway 启动到用户手动 reset 或每日 4AM 自动 reset）。随着对话积累，上下文窗口不断膨胀，OpenClaw 通过以下机制管理：

- **cache-ttl 修剪**：超过 TTL（默认 1 小时）未被引用的上下文自动丢弃
- **compaction (safeguard 模式)**：当 `contextTokens > contextWindow - reserveTokensFloor` 时，将旧对话摘要化，腾出 token 空间
- **memory flush**：compaction 前的静默 agent 轮次，提醒 agent 将重要信息写入持久化 memory 文件

**问题**：compaction 是**有损压缩**。多轮压缩后会产生：
1. **信息丢失** — 关键指令的退出条件被压缩掉，但指令本体保留，导致行为污染（真实案例：boot 自检的 `NO_REPLY` 规则残留在 session 中，污染了后续所有正常对话）
2. **隐性退化** — 模型能力逐渐下降，但用户感知不到（bot 还在回复，只是越来越偏）
3. **不可控性** — 用户无法控制"压缩丢什么"，完全由模型内部的注意力权重决定
4. **累积性** — 每次 compaction 都在上一次的摘要基础上再摘要，信息损失是**指数级累积**的

### 1.3 核心思路：Core Rotation（芯片轮换）

来源项目：[DAOKit](https://github.com/who96/DAOKit) 的 Observer-Relay + Core Rotation 模式。

核心思想：
- **Observer（观察者）层**：OpenClaw 的 Telegram/Discord channel 天然就是 Observer 层（只负责消息收发）
- **Core Rotation（芯片轮换）**：当 agent session 经历了 N 次 compaction（即信息经历了 N 轮有损丢失），自动创建新 session，将 OpenClaw 已有的 memory flush 产出 + 最近原始消息注入新 session，然后切换。类比"换芯片"——大脑换新的，但记忆已经由 OpenClaw 原生机制持久化保存。

### 1.4 为什么用 compaction 次数而不是 context% 触发

| | context% 阈值 | compaction 次数 |
|---|---|---|
| **语义** | token 用量的代理指标 | 直接量化"信息经历了几轮有损丢失" |
| **因果关系** | 与退化无直接因果关系 | compaction 是退化的直接原因 |
| **准确性** | context% 高不一定退化（可能只是长回复） | 3 次 compaction = 信息已被 3 轮有损压缩 |
| **实现** | 需要 token counting API（OpenClaw 未暴露给插件） | `sessions.json` 的 `compactionCount` 字段直接可读 |

---

## 2. 需求概述（What）

### 2.1 一句话描述

开发一个 OpenClaw plugin，当 agent session 的 compaction 次数达到阈值时，自动执行"换芯"：归档旧 session，创建新 session，将已有 memory 文件和最近消息注入新 session，实现无感续跑。

### 2.2 用户故事

**作为** OpenClaw 的用户，
**我希望** 我的 bot 能在长时间运行后仍然保持稳定的回复质量，
**以便** 我不需要手动监控 session 状态或定期执行 `/new` 来重置。

**作为** OpenClaw 的用户，
**我希望** "换芯"过程对我透明无感，
**以便** 我在 Telegram 上跟 bot 聊天时不会因为 session 切换而中断体验。

### 2.3 核心功能清单

| ID | 功能 | 优先级 |
|----|------|--------|
| F1 | 退化检测（hook 到 `after_compaction` 事件，读取 `compactionCount`） | P0 |
| F2 | Session 轮换（归档旧 session → reset → 创建新 session → 注入状态） | P0 |
| F3 | 状态注入（从 memory files + 最近 N 条原始消息组装注入内容） | P0 |
| F4 | 切换协调（活跃任务检测、冷却期防抖、崩溃恢复） | P0 |
| F5 | 用户通知（换芯时通过 channel 告知用户） | P1 |
| F6 | 手动触发换芯（用户通过命令主动触发） | P1 |
| F7 | 轮换历史记录（rotation-state.json 记录每次换芯） | P2 |

### 2.4 设计原则

- **不重复造轮子** — 状态保存复用 OpenClaw 已有的 memory flush 产出
- **不引入外部依赖** — 纯 plugin，用户装上就能用
- **一条代码路径** — 没有 if/else 分支选择注入策略，只有结构化注入
- **触发逻辑准确** — compaction 次数比 context% 更直接反映退化程度
- **做且只做 OpenClaw 没做的事** — 检测、切换、注入、协调

---

## 3. 技术架构（How）

### 3.1 集成方式：OpenClaw Plugin Hook

**关键约束：不修改 OpenClaw 源码**，通过官方支持的扩展点集成。

使用的 OpenClaw 扩展机制：

| 机制 | 用途 |
|------|------|
| `after_compaction` hook | 退化检测（每次 compaction 后触发，读取 compactionCount） |
| `gateway:startup` hook | 崩溃恢复（gateway 重启后从断点恢复 rotation 流程） |
| Memory Files | 状态注入的数据源（读取 OpenClaw memory flush 已写入的文件） |
| Session API | session reset、新 session 创建 |
| Custom Commands (lcmd) | 手动触发换芯命令 |

**已验证**：`after_compaction` hook 自 PR #14882 起已接线，包含在所有 v2026.2.x 版本中。

### 3.2 整体流程

```
┌───────────────────────────────────────────────────────┐
│                    OpenClaw Gateway                    │
│                                                        │
│  ┌──────────────────┐    ┌───────────────────────────┐│
│  │ after_compaction  │───▶│  Core Rotation Plugin     ││
│  │ (event hook)      │    │                           ││
│  └──────────────────┘    │  1. 读 compactionCount     ││
│                           │  2. if >= 阈值:            ││
│  ┌──────────────────┐    │     a. 检查活跃任务        ││
│  │ gateway:startup   │───▶│     b. 归档旧 session      ││
│  │ (recovery hook)   │    │     c. reset + 注入新 ses. ││
│  └──────────────────┘    │     d. 进入冷却期          ││
│                           │     e. 通知用户            ││
│                           └───────────────────────────┘│
│                                                        │
│  ┌───────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Telegram  │  │  Discord  │  │  Other Channels  │  │
│  │ (Observer)│  │ (Observer)│  │    (Observer)     │  │
│  └───────────┘  └───────────┘  └──────────────────┘  │
└───────────────────────────────────────────────────────┘
```

### 3.3 数据流（单一路径）

```
after_compaction 事件触发
    │
    ▼
读取 sessions.json → compactionCount >= 阈值?
    │ No → return (等下一次)
    │ Yes ↓
    ▼
检查活跃任务 → 有任务在跑?
    │ Yes → 推迟，等下一次 compaction 重新检查
    │ No ↓
    ▼
Phase 1: ARCHIVE（安全，非破坏性）
    │  copy {sessionId}.jsonl → sessions/archive/{sessionId}.jsonl
    │  validate archive completeness
    │  write rotation-state.json = ARCHIVED
    ▼
Phase 2: RESET + INJECT（合并为一个逻辑操作）
    │  generate newSessionId
    │  组装注入内容:
    │    ├── MEMORY.md（长期记忆）
    │    ├── memory/today.md（今日日志）
    │    ├── memory/yesterday.md（昨日日志）
    │    ├── 最近 5 轮 user+assistant 消息（从旧 session JSONL 提取）
    │    └── rotation 元数据（为什么换芯、第几次、旧 session ID）
    │  检查注入大小 ≤ 15% contextWindow（防死循环）
    │  write new JSONL (header + injected state as system message)
    │  update sessions.json pointer → newSessionId
    │  write rotation-state.json = INJECTED
    ▼
进入 COOLDOWN
    │  write rotation-state.json = COOLDOWN (cooldownUntil = now + 30min)
    │  通知用户
    ▼
冷却期结束 → IDLE
```

---

## 4. 详细设计

### 4.1 配置结构（openclaw.json 中新增字段）

```json5
{
  "plugins": {
    "core-rotation": {
      "enabled": true,
      // 触发阈值：compaction 次数达到此值时触发换芯
      "compactionCountThreshold": 3,
      // 注入预算：占 contextWindow 的百分比上限
      "injectionBudgetPercent": 0.15,
      // 注入时保留的最近消息轮数（user+assistant 为一轮）
      "recentMessagePairs": 5,
      // 旧 session 归档策略: "archive"(保留) | "delete"(删除)
      "oldSessionPolicy": "archive",
      // 换芯时通知用户
      "notifyOnRotation": true,
      // 冷却期：compaction 次数下限 + 时间下限（两者都满足才允许下一次）
      "cooldown": {
        "minCompactions": 3,
        "minMinutes": 30
      },
      // 断路器：时间窗口内最大 rotation 次数
      "circuitBreaker": {
        "maxRotations": 3,
        "windowMinutes": 30
      }
    }
  }
}
```

### 4.2 状态机设计

#### 4.2.1 状态转换图

```
IDLE → PENDING → ARCHIVING → ARCHIVED → INJECTED → COOLDOWN → IDLE

              ┌──────┐ threshold  ┌─────────┐ no active  ┌───────────┐
              │ IDLE │──exceeded─▶│ PENDING │──tasks─────▶│ ARCHIVING │
              │      │            │         │             │           │
              └──┬───┘            └────┬────┘             └─────┬─────┘
                 │                     │                        │
                 │                tasks active              archive
                 │                (stay, defer)             complete
                 │                     │                        │
                 │                     ▼                        ▼
                 │               ┌──────────┐           ┌──────────┐
                 │               │   IDLE   │           │ ARCHIVED │
                 │               │(deferred)│           │          │
                 │               └──────────┘           └─────┬────┘
                 │                                            │
                 │                                       reset+inject
                 │                                       (combined op)
                 │                                            │
                 │                                            ▼
                 │   cooldown     ┌──────────┐          ┌──────────┐
                 │◀──expires──────│ COOLDOWN │◀─────────│ INJECTED │
                 │                │          │           │          │
                 └────────────────┴──────────┘           └──────────┘
```

#### 4.2.2 状态文件

**路径**：`~/.openclaw/agents/{agentId}/rotation-state.json`

```json
{
  "version": 1,
  "state": "IDLE",
  "startedAt": null,
  "oldSessionId": null,
  "oldSessionFile": null,
  "archivePath": null,
  "newSessionId": null,
  "cooldownUntil": null,
  "triggerCompactionCount": null,
  "rotationHistory": [],
  "error": null,
  "updatedAt": "2026-02-15T10:00:00.000Z"
}
```

**写入方式**：write-then-rename（POSIX rename 原子性保证崩溃安全）

```typescript
writeFileSync(statePath + '.tmp', JSON.stringify(state));
renameSync(statePath + '.tmp', statePath);
```

#### 4.2.3 崩溃恢复逻辑

`gateway:startup` hook 读取 `rotation-state.json`，根据当前状态决定恢复动作：

| 发现的状态 | 含义 | 恢复动作 |
|---|---|---|
| `IDLE` | 没有进行中的 rotation | 无需操作 |
| `PENDING` | 检测到阈值但还没开始归档 | 重新检查活跃任务 → 继续或回退到 IDLE |
| `ARCHIVING` | 正在归档 | 校验 `archivePath` 文件完整性。完整 → 推进到 ARCHIVED。不完整 → 删除残留文件，重新归档 |
| `ARCHIVED` | 归档完成，reset+inject 未执行 | 旧 session 未动（安全），直接执行 Phase 2 |
| `INJECTED` | reset+inject 完成，cooldown 未设置 | 设置 cooldown → 推进到 COOLDOWN |
| `COOLDOWN` | 冷却中 | 检查 `cooldownUntil` 是否过期 → 过期则 IDLE，否则继续等 |

**archive 文件完整性校验**：
1. `archivePath` 文件存在
2. 首行是有效 JSON（session header）
3. 末行是有效 JSON（未截断）
4. 行数与旧 session 文件一致

### 4.3 状态注入设计

#### 4.3.1 注入内容来源

**关键决定：不让退化的 agent 自己总结。** 一个已经经历 3 轮 compaction 的 agent 做总结，就像让醉鬼告诉你他忘了什么。复用 OpenClaw 原生 memory flush 的产出——那是 agent 在还清醒时写的。

| 来源 | 路径 | 估算大小 |
|------|------|---------|
| MEMORY.md（长期记忆） | `~/.openclaw/workspace/MEMORY.md` | ~1,500 tokens |
| 今天的 daily log | `~/.openclaw/workspace/memory/YYYY-MM-DD.md` | ~3,000 tokens |
| 昨天的 daily log | `~/.openclaw/workspace/memory/YYYY-MM-DD.md` | ~3,000 tokens |
| 最近 5 轮消息 | 从旧 session JSONL 尾部提取 | ~10,000 tokens |
| rotation 元数据 | plugin 生成 | ~500 tokens |
| **合计** | | **~18,000 tokens** |
| **安全余量** | | **~12,000 tokens** |
| **预算上限** | contextWindow × 15% | **~30,000 tokens** |

#### 4.3.2 注入格式

作为系统消息注入新 session：

```
[SYSTEM] This is a fresh session after automatic core rotation.
Previous session was archived after {N} compactions.

## Inherited Memory

### Long-term Memory (MEMORY.md)
{MEMORY.md 内容}

### Recent Daily Log
{today's daily log 内容}

### Recent Conversation (last 5 exchanges)
{最近 5 轮 user+assistant 的原始消息}

### Rotation Context
- Rotation #: {rotation_count}
- Reason: compactionCount reached {N}
- Previous session: {old_session_id}
- Archive: {archive_path}

Continue serving the user based on this context.
```

#### 4.3.3 Token 预算与防死循环

**核心数字（200K context window，默认配置）：**

```
contextWindow           = 200,000 tokens
reserveTokensFloor      = 20,000 tokens（默认）
softThresholdTokens     = 4,000 tokens（默认）
系统提示词 + 工具       ≈ 10,000 tokens
bootstrap 文件          ≈ 6,000 tokens
─────────────────────────────────
实际可用对话空间         ≈ 164,000 tokens
compaction 触发线       = 180,000 tokens
```

**注入 30K tokens (15%) 后：** 剩余 ~134K 可用 → 约 45 轮普通对话才触发下一次 compaction。

**死循环阈值：** 注入 > 80% contextWindow (~131K+ tokens)。15% 远低于此线。

**Token 计算方法：** OpenClaw 不暴露 `estimateTokens()` API 给插件。使用 OpenClaw 内部同款启发式方法：

```typescript
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4); // ~4 chars per token (English)
}
```

**四重防死循环保险：**

1. **硬上限截断**：注入前估算 token 数。超过 `contextWindow × injectionBudgetPercent` 时，按优先级截断：
   - 第一步：砍掉昨天的 daily log
   - 第二步：减少消息轮数从 5 到 3
   - 第三步：截断 MEMORY.md（保留头 70% + 尾 20%）
   - 第四步：仅保留 MEMORY.md + 最后 1 轮消息

2. **断路器**：`windowMinutes` 内 rotation 次数超过 `maxRotations` → 停止所有自动 rotation，回退到原生 compaction，输出警告日志

3. **指数退避**：连续 rotation 时逐步缩小注入预算：
   - 第 1 次：15% 预算
   - 第 2 次：10% 预算（砍 daily logs，减 N 到 3）
   - 第 3 次：5% 预算（仅 MEMORY.md + 1 轮消息）
   - 第 4 次：断路器跳闸

4. **健康检查**：rotation 完成后，如果新 session 在 10 轮对话内再次触发 compaction，自动降低下一次注入预算

### 4.4 冷却期设计

**混合策略：compaction 次数 + 时间下限，两者都满足才允许下一次 rotation。**

```json
{ "minCompactions": 3, "minMinutes": 30 }
```

**为什么不用纯时间**：用户 6 小时不活跃后，第一次 compaction 就触发 rotation 是浪费的。
**为什么不用纯次数**：高频工具使用场景下，compaction 可能每几分钟一次，纯次数会导致频繁 rotation。

### 4.5 活跃任务检测

rotation 前检查是否有正在执行的任务。如果有，推迟到下一次 `after_compaction` 事件重新判断。

检测方式：检查 session 中是否有未完成的 tool call（`tool_use` 已发出但 `tool_result` 未返回）。

---

## 5. 约束与边界

### 5.1 必须遵守

- **不修改 OpenClaw 源码** — 所有功能通过 plugin hook / memory files / lcmd 实现
- **不中断用户体验** — 换芯过程对用户透明，最多发一条通知消息
- **不丢失活跃任务** — 如果有正在执行的任务，推迟换芯
- **向后兼容** — plugin 被卸载后，OpenClaw 回退到原生行为，不留副作用
- **崩溃安全** — 任何步骤中断后，gateway 重启能从断点恢复或安全回退
- **幂等性** — 状态机保证同一次 rotation 不会被重复执行

### 5.2 不在范围内

- 不改变 OpenClaw 的 compaction 机制本身
- 不试图改进 OpenClaw 的 context 评估算法
- 不做跨 agent 的 session 迁移（只处理单个 agent 的 session 轮换）
- 不替代 OpenClaw 已有的 `/new` 和 `/reset` 命令（这是增量，不是替代）
- 不自行实现 memory flush（复用 OpenClaw 原生产出）

---

## 6. 关键文件路径（OpenClaw 标准布局）

| 路径 | 说明 | 读/写 |
|------|------|-------|
| `~/.openclaw/openclaw.json` | OpenClaw 主配置（plugin 配置在此） | 读 |
| `~/.openclaw/agents/{agent}/sessions/sessions.json` | Session 元数据（含 `compactionCount`） | 读 |
| `~/.openclaw/agents/{agent}/sessions/{sessionId}.jsonl` | Session 对话记录（append-only JSONL） | 读 |
| `~/.openclaw/agents/{agent}/sessions/archive/` | 归档的旧 session 文件 | 写 |
| `~/.openclaw/agents/{agent}/rotation-state.json` | Rotation 状态机持久化文件 | 读/写 |
| `~/.openclaw/workspace/MEMORY.md` | Agent 长期记忆文件 | 读 |
| `~/.openclaw/workspace/memory/YYYY-MM-DD.md` | Agent 每日日志文件 | 读 |
| `~/Library/LaunchAgents/ai.openclaw.gateway.plist` | macOS LaunchAgent 配置 | — |
| `/tmp/openclaw/` | 运行时日志目录 | 写（日志） |

---

## 7. 实现结构

```
core-rotation/
├── HOOK.md              # Hook 元数据（YAML frontmatter：事件声明、描述）
├── handler.ts           # 核心逻辑（~200-300 行）
│   ├── onAfterCompaction()   # 退化检测 + 触发 rotation
│   ├── onGatewayStartup()    # 崩溃恢复
│   ├── rotate()              # Phase 1 (archive) + Phase 2 (reset+inject)
│   ├── buildInjectionPayload() # 组装注入内容
│   ├── estimateTokens()      # chars/4 启发式 token 估算
│   └── recovery()            # 状态机恢复逻辑
└── package.json         # Plugin 声明（openclaw.extensions）
```

**零外部依赖**：只使用 Node.js 标准库（`fs`、`path`）和 OpenClaw Plugin SDK 类型。

---

## 8. 验收标准

### 8.1 基本功能（P0）

- [ ] plugin 加载后，`after_compaction` hook 正常触发并读取 `compactionCount`
- [ ] `compactionCount >= compactionCountThreshold` 时，自动触发换芯流程
- [ ] 换芯后新 session 包含 MEMORY.md + daily log + 最近消息的注入内容
- [ ] 换芯后用户发消息能收到正常回复（不是 NO_REPLY 或垃圾）
- [ ] rotation-state.json 正确记录每次换芯状态

### 8.2 稳定性（P0）

- [ ] 注入内容不超过 `contextWindow × injectionBudgetPercent`
- [ ] 有活跃任务时推迟换芯
- [ ] gateway 崩溃后重启，能从 rotation-state.json 恢复或安全回退
- [ ] 连续 rotation 触发断路器后停止自动换芯并输出警告

### 8.3 用户体验（P1）

- [ ] 换芯时通过 channel 发送一条简短通知
- [ ] 用户可通过 lcmd 命令手动触发换芯
- [ ] 用户可通过配置 `enabled: false` 禁用自动换芯
- [ ] 旧 session 归档文件保留在 `sessions/archive/` 可查阅

### 8.4 冷却与防抖（P1）

- [ ] 冷却期内不触发 rotation（`minCompactions` + `minMinutes` 双条件）
- [ ] 断路器：30 分钟内 > 3 次 rotation → 停止
- [ ] 指数退避：连续 rotation 缩小注入预算

---

## 9. 术语表

| 术语 | 定义 |
|------|------|
| **Core Rotation（芯片轮换/换芯）** | 将退化的 session 替换为新 session，同时迁移关键状态 |
| **Observer-Relay** | 一种架构模式：外层窗口只负责消息转发，不承担决策逻辑 |
| **Compaction** | OpenClaw 原生的上下文压缩机制（将旧对话摘要化），每次执行后 `compactionCount` 自增 |
| **compactionCount** | `sessions.json` 中的字段，记录当前 session 的 compaction 累计次数 |
| **Memory Flush** | OpenClaw 在 compaction 前执行的静默 agent 轮次，将重要信息写入持久化 memory 文件 |
| **Injection Payload（注入负载）** | rotation 时注入新 session 的结构化内容（memory files + 最近消息 + 元数据） |
| **Injection Budget（注入预算）** | 注入内容的 token 上限，默认为 contextWindow 的 15% |
| **Circuit Breaker（断路器）** | 安全机制：时间窗口内 rotation 次数过多时自动停止 |
| **Session** | OpenClaw 中的对话历史，以 jsonl 文件持久化存储 |
| **rotation-state.json** | Plugin 的状态机持久化文件，用于崩溃恢复 |

---

## 10. 已验证的技术基础

以下结论均经过实际调研验证（2026-02-15）：

### 10.1 Compaction Hook 可用性 ✅

- `before_compaction` 和 `after_compaction` hook 自 PR #14882 起已接线
- 包含在所有 v2026.2.x 版本中（当前最新 v2026.2.13）
- `sessions.json` 中的 `compactionCount` 字段每次 compaction 后自增，可直接读取
- 相关 Issue：#6535（hooks 存在但未接线 → 已修复）、#11799（更丰富的 compaction 事件 → 未来增强）

### 10.2 Token 预算安全性 ✅

- 200K context window 下，15% 注入 (30K tokens) 后仍有 ~134K 可用空间
- 约 45 轮普通对话才触发下一次 compaction，远离死循环
- 死循环阈值为注入 > 80% contextWindow，15% 预算有极大安全余量
- OpenClaw 不暴露 `estimateTokens()` API（Issue #12299 仍 open），使用 chars/4 启发式方法
- 四重防死循环机制（硬上限截断 + 断路器 + 指数退避 + 健康检查）

### 10.3 崩溃安全性 ✅

- `gateway:startup` hook 可用于恢复逻辑
- OpenClaw session 文件是 append-only JSONL，天然具有崩溃韧性
- `sessions.json` 指针更新是唯一的"提交点"——更新前旧 session 仍活跃（安全），更新后新 session 就绪（期望状态）
- POSIX `rename()` 原子性保证状态文件写入的崩溃安全
- 两阶段设计（archive + reset/inject）消除了最危险的崩溃窗口

---

## 11. 参考资料

- [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)
- [OpenClaw Compaction 文档](https://docs.openclaw.ai/concepts/compaction)
- [OpenClaw Session 管理文档](https://docs.openclaw.ai/reference/session-management-compaction)
- [OpenClaw Plugin 文档](https://docs.openclaw.ai/tools/plugin)
- [OpenClaw Hooks 文档](https://docs.openclaw.ai/cli/hooks)
- [PR #14882 — 接线 before/after_compaction 等生命周期 hooks](https://github.com/openclaw/openclaw/pull/14882)
- [Issue #6535 — Plugin hooks 存在但未接线](https://github.com/openclaw/openclaw/issues/6535)
- [Issue #11799 — session:compacted 更丰富事件](https://github.com/openclaw/openclaw/issues/11799)
- [Issue #12299 — 请求暴露 token counting API](https://github.com/openclaw/openclaw/issues/12299)
- [Issue #8185 — Memory flush on /new and /reset](https://github.com/openclaw/openclaw/issues/8185)
- [Issue #2788 — RLM for unbounded context（被拒绝的激进方案）](https://github.com/openclaw/openclaw/issues/2788)
- [DAOKit — Observer-Relay + Core Rotation 参考实现](https://github.com/who96/DAOKit)
