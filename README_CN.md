# OpenClaw 芯片轮换插件 (Core Rotation)

**[English README](./README.md)**

> 你的 AI 助手聊久了会变笨。这个插件自动给它"换芯" —— 大脑换新的，记忆带着走。

---

## 痛点

OpenClaw 让你的 AI 助手 7x24 小时在线，跨 Telegram、Discord 等多渠道服务。但长时间运行有个隐藏代价：**上下文压缩 (compaction)**。

每当对话窗口快满了，OpenClaw 会把旧对话压缩成摘要。这是**有损**的。经过 3 轮以上的压缩，关键指令被压碎、退出条件丢失、bot 开始跑偏 —— 但表面上看起来还在正常回复。

**真实案例：** boot 自检规则里的 `NO_REPLY` 指令被部分压缩，退出条件丢了但规则本体还在。结果：bot 对后续所有消息都返回 `NO_REPLY`，静默地搞砸了所有对话。

## 方案

**Core Rotation（芯片轮换）** 检测到你的 agent 经历了太多次压缩后，自动执行"换芯"：

1. **检测** — 挂钩 OpenClaw 的 `after_compaction` 事件。当 `compactionCount` 达到阈值（默认 3），触发轮换。
2. **归档** — 安全地把旧 session 复制到 `sessions/archive/`。旧数据永远不会丢失。
3. **注入** — 读取 agent 已有的记忆文件（MEMORY.md、每日日志）加上最近 5 轮对话，注入到全新的 session 中。
4. **协调** — 等待正在执行的任务完成。用断路器防止轮换风暴。Gateway 崩溃后自动恢复。

**效果：** 你的 bot 获得一个干净的上下文窗口，同时所有重要记忆都保留下来 —— 就像换了一块新芯片，但记忆跟着走。

## 为什么这样设计

| 设计选择 | 原因 |
|---|---|
| **用 compaction 次数触发**（不是定时器、不是 context%） | 直接量化"信息被有损压缩了几次" —— 退化的直接原因 |
| **复用 OpenClaw 的 memory flush 产出** | OpenClaw 在每次压缩前已经把重要信息写到磁盘了。我们直接读这些文件，而不是让一个已经退化的 agent 自己做总结（让醉鬼告诉你他忘了什么？） |
| **一条代码路径** | 没有 if/else 分支选择注入策略。一种检测方式、一种轮换方式、一种注入方式。分支越少 = bug 越少 |
| **崩溃安全状态机** | 每一步操作前都先持久化状态。Gateway 中途崩了？重启后从断点继续 |
| **零外部依赖** | 只用 Node.js 标准库 + OpenClaw Plugin SDK 类型。装上就能用 |

## 快速开始

### 安装

```bash
git clone https://github.com/who96/openclaw-core-rotation.git
cd openclaw-core-rotation
npm install
npm run build
```

### 注册到 OpenClaw

把编译后的插件复制到 OpenClaw 本地插件目录：

```bash
cp -r . ~/.openclaw/workspace/local-plugins/core-rotation/
```

在 OpenClaw 配置 (`~/.openclaw/openclaw.json`) 中添加：

```json
{
  "plugins": {
    "entries": {
      "core-rotation": { "enabled": true }
    }
  }
}
```

### 配置（可选）

编辑 `~/.openclaw/workspace/local-plugins/core-rotation/config.json`：

```json
{
  "enabled": true,
  "compactionCountThreshold": 3,
  "injectionBudgetPercent": 0.15,
  "recentMessagePairs": 5,
  "notifyOnRotation": false,
  "cooldown": {
    "minCompactions": 3,
    "minMinutes": 30
  },
  "circuitBreaker": {
    "maxRotations": 3,
    "windowMinutes": 30
  }
}
```

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `compactionCountThreshold` | 3 | 触发轮换的 compaction 次数 |
| `injectionBudgetPercent` | 0.15 | 注入内容占 context window 的比例上限 |
| `recentMessagePairs` | 5 | 注入最近几轮对话 |
| `cooldown.minCompactions` | 3 | 冷却期：至少等几次 compaction |
| `cooldown.minMinutes` | 30 | 冷却期：至少等几分钟 |
| `circuitBreaker.maxRotations` | 3 | 断路器：30 分钟内最多轮换几次 |

### 验证

重启 OpenClaw gateway，检查日志确认插件加载成功。当任何 agent 的 `compactionCount` 达到阈值时，插件自动触发。

## 工作原理

```
after_compaction 事件触发
        |
        v
compactionCount >= 3?  --否--> 等待
        |
       是
        |
        v
有活跃任务?  --是--> 推迟
        |
       否
        |
        v
+------ 阶段 1：归档（安全，非破坏性）-----------+
|  copy session.jsonl --> sessions/archive/        |
|  校验归档完整性                                  |
+--------------------------------------------------+
        |
        v
+------ 阶段 2：重置 + 注入（合并操作）-----------+
|  读取 MEMORY.md + 每日日志 + 最近 5 轮对话       |
|  检查 token 预算（context window 的 15%）        |
|  创建新 session 并注入状态                       |
+--------------------------------------------------+
        |
        v
    冷却期（30 分钟 + 3 次 compaction 双条件）
```

### 四重防死循环保险

| 层级 | 机制 |
|------|------|
| 硬上限 | 注入内容超过 context window 的 15% 时自动截断 |
| 断路器 | 30 分钟内超过 3 次轮换 → 自动停止 |
| 指数退避 | 连续轮换时预算递减：15% → 10% → 5% |
| 健康检查 | 新 session 如果 10 轮内再次触发 compaction，自动降低下次预算 |

### 崩溃安全

插件使用 6 状态机，通过原子性 write-then-rename 持久化：

```
IDLE → PENDING → ARCHIVING → ARCHIVED → INJECTED → COOLDOWN → IDLE
```

Gateway 在**任意步骤**崩溃后，`gateway:startup` hook 读取状态文件，从断点恢复或安全回退。

## 环境要求

- OpenClaw >= v2026.2.0（需要 PR #14882 引入的 `after_compaction` hook）
- Node.js >= 18

## 测试

```bash
npm run build
npm test
# 68 tests, 12 suites, 0 failures
```

## Roadmap

- [x] 基于 compaction 次数的退化检测
- [x] 崩溃安全的 session 轮换状态机
- [x] 带 token 预算的记忆注入
- [x] 四重防死循环保护
- [ ] 轮换时用户通知（需要 channel API）
- [ ] 手动触发命令 (`/rotate`)
- [ ] 直接更新 `sessions.json` 指针
- [ ] 可配置注入模板

## 致谢

- 灵感来自 [DAOKit](https://github.com/who96/DAOKit) 的 Observer-Relay + Core Rotation 架构
- 为 [OpenClaw](https://github.com/openclaw/openclaw) 构建

## License

MIT
