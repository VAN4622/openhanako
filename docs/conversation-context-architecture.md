# 多频道共享上下文设计说明

本文档记录 OpenHanako 当前这套“多频道共享上下文”改造的设计目标、数据结构、运行流程、与原记忆系统的关系，以及后续开发时应遵守的约束。

这份文档面向未来维护者。重点不是解释某一行代码，而是说明：

- 我们为什么没有选择“所有渠道共用一个 transcript”
- 为什么现在采用 `canonical timeline -> snapshot -> delta recall`
- 这套设计和原有 memory 系统如何协同
- 后续继续开发时，哪些边界不能破坏

---

## 1. 问题背景

原始项目中：

- 本地桌面聊天以单个 session transcript 为主
- 外部 IM Bridge 也以各自 session transcript 为主
- 不同入口之间没有统一的“逻辑会话权威源”

这会导致一个问题：

- 用户在 PC 端聊到一半
- 切到 QQ / Telegram / 飞书继续同一个话题
- 当前渠道自己的 transcript 并不知道另一个渠道刚刚发生了什么

而我们的目标不是“把所有渠道的聊天记录合并成一个文件”，而是：

- 同一个逻辑会话在不同渠道之间共享运行上下文
- 不同渠道仍保留各自的展示历史和交互投影
- 模型能够继续同一件事，但不混淆“这句话到底在哪个渠道发生”

这和人类沟通很像：

- 电话、IM、邮件不是同一个历史文件
- 但如果都是同一件事，人脑里对“当前事情进行到哪了”的理解是共享的

---

## 2. 设计目标

### 2.1 要解决的问题

- 同一逻辑会话跨渠道续接
- 不依赖共用 transcript 文件
- 不丢原始事实
- 不污染当前渠道的消息归属
- 尽量少改原有 memory 机制

### 2.2 不解决的问题

- 不把“同一个人”自动等价成“同一个 conversation”
- 不要求跨 conversation 的强一致
- 不让 guest bridge 继承 owner 的完整上下文
- 不用共享上下文替代长期 memory

---

## 3. 核心原则

### 3.1 Timeline First

权威源不是某个 session transcript，而是某个 conversation 的事件流。

### 3.2 Transcript Second

各渠道仍然保留自己的 transcript，但它们只是各自的投影，不是权威上下文。

### 3.3 Snapshot + Delta

模型召回不走“全量历史回放”，而是：

- 先读结构化 snapshot
- 再读未消费的跨渠道 delta

### 3.4 Memory Third

这套 conversation context 是“会话级运行上下文”，不是对原 memory 系统的替代。

memory 仍然负责：

- 跨会话沉淀
- 更长期的个人事实、习惯、经历

conversation context 负责：

- 同一会话的跨渠道连续性

### 3.5 Source Attribution Must Stay Exact

这是整套设计里最容易被破坏的一条：

- 桌面发生的事必须仍然被识别为桌面
- QQ 发生的事必须仍然被识别为 QQ
- 共享上下文不能伪装成“当前渠道刚刚发出的消息”

---

## 4. 当前架构

当前采用三层结构：

```text
channel transcript
    ↓
canonical conversation timeline
    ↓
conversation snapshot + delta recall
    ↓
model prompt context
```

### 4.1 Channel Transcript

每个本地 session / bridge session 仍有自己的历史文件，用于：

- 当前渠道的可见历史
- 兼容项目现有 session 机制

### 4.2 Canonical Conversation Timeline

新增权威事件流，保存某个逻辑会话中来自不同渠道的事件。

特点：

- 每个 agent 独立维护
- 不与 memory 文件混放
- 不依赖单一渠道 transcript

### 4.3 Conversation Snapshot

从 timeline 派生的结构化快照，用来表达“当前这件事进行到哪了”。

### 4.4 Delta Recall

每个入口维护自己的 cursor，仅召回“这个入口还没看过”的跨渠道事件增量。

---

## 5. 数据落盘位置

每个 agent 下新增：

```text
agents/<agent>/conversations/
  bindings.json
  index.json
  timelines/<conversationId>.jsonl
  snapshots/<conversationId>.json
```

### 5.1 bindings.json

保存：

- `localSessions -> conversationId`
- `bridgeOwnerSessions -> conversationId`
- `bridgeGuestSessions -> conversationId`
- 每个绑定自己的 `lastSeenSeq`

### 5.2 index.json

保存 conversation 级元信息：

- `lastSeq`
- `updatedAt`
- 绑定了哪些 source
- conversation 的来源桶

### 5.3 timelines/*.jsonl

保存 canonical event log。

每一行是一次事件，当前主要是 `session_message`。

### 5.4 snapshots/*.json

保存 conversation 的派生运行态快照。

---

## 6. 当前 snapshot schema

当前 snapshot 里已经稳定下来的字段：

- `lastUserMessage`
- `lastAssistantMessage`
- `recentToolResults`
- `currentObjective`
- `openLoops`
- `confirmedConstraints`
- `recentDecisions`
- `sources`

### 6.1 字段语义

#### `lastUserMessage`

最近一条用户消息，保留来源。

#### `lastAssistantMessage`

最近一条助手消息，保留来源。

#### `recentToolResults`

最近几条工具结果，用于恢复“这轮执行到哪了”。

#### `currentObjective`

当前会话里“此刻正在做什么”的轻量表达。

当前实现中，规则上优先取最近用户消息作为 objective 的近似。

#### `openLoops`

尚未闭合的问题、待继续处理的点。

当前实现中，主要基于疑问句和任务性问题做启发式提取。

#### `confirmedConstraints`

已经明确确认的约束，例如：

- 不要共享 transcript
- 必须保留来源归属
- 先不做某件事

#### `recentDecisions`

近期明确拍板的决定，例如：

- 改成 snapshot + delta
- 不再走用户前缀注入

---

## 7. 运行流程

### 7.1 本地会话

1. 创建 / 打开本地 session
2. `ConversationManager.ensureLocalSession()` 绑定 conversation
3. prompt 前调用 `prepareLocalPromptContext()`
4. 拿到 `snapshot + pending delta`
5. 通过 `before_agent_start` 作为独立 `custom message` 注入
6. 本轮结束后：
   - `memoryTicker.notifyTurn(sessionPath)`
   - `appendLocalSessionMessages(...)`
   - 更新 cursor

### 7.2 Bridge Owner 会话

1. 收到 owner 消息
2. 尝试自动关联当前本地会话
3. `ensureBridgeSession()`
4. prompt 前调用 `prepareBridgePromptContext()`
5. 通过独立 `custom message` 注入共享上下文
6. 本轮结束后：
   - `appendBridgeSessionMessages(...)`
   - 更新 cursor

### 7.3 Bridge Guest 会话

guest 仍然隔离，不接这条共享上下文链路。

这是有意保留的产品边界。

---

## 8. 为什么不再使用“用户前缀注入”

早期 MVP 里，我们把共享上下文拼成“当前用户消息前缀”。

这样虽然能快速验证跨渠道续接，但有明显问题：

- 模型容易把其他渠道消息误认为当前渠道消息
- 来源归属容易错
- 语义上不干净

现在已经改成：

- 使用 Pi SDK 的 `before_agent_start`
- 注入独立的 `custom message`
- 必要时附加临时 system rules

这样更符合当前 runtime 的扩展方式，也更接近长期维护的最佳实践。

---

## 9. 为什么 synthetic context 不能写回 timeline

共享上下文本身是 timeline 的派生物。

如果把它再写回 canonical timeline，会出现：

- timeline 包含自己的二次摘要
- 下次 snapshot 再从这些 synthetic message 里继续抽
- 形成上下文自我污染

因此当前实现里：

- `shared_conversation_context` 会进入本轮模型上下文
- 但不会写回 canonical timeline

这是硬约束，不要破坏。

---

## 10. 与原有 memory 系统的关系

这套设计与 memory 系统是并行协同关系，不是替代关系。

### 10.1 memory 仍然负责

- 会话之后的长期沉淀
- `today/week/longterm/facts` 编译
- agent 级长期记忆

### 10.2 conversation context 负责

- 同一逻辑会话的跨渠道连续性
- 当前运行态恢复
- 当前任务上下文的强一致续接

### 10.3 当前协作边界

- `SessionCoordinator.prompt()` 结束后仍会正常调用 `memoryTicker.notifyTurn()`
- `notifySessionEnd()` 逻辑没有被 conversation 层替换
- conversation 数据独立存放在 `conversations/`
- memory 数据仍在 `memory/`

也就是说：

`conversation context = 会话级`

`memory = agent 级 / 跨会话级`

二者互补，而不是互斥。

---

## 11. 当前文件入口

### 核心实现

- `lib/conversations/conversation-manager.js`
- `core/session-coordinator.js`
- `core/bridge-session-manager.js`
- `server/routes/conversations.js`

### 前端可视化

- `desktop/src/react/components/BridgePanel.tsx`
- `desktop/src/styles.css`

### 测试

- `lib/conversations/conversation-manager.test.js`
- `core/bridge-session-manager.test.js`
- `tests/session-coordinator.test.js`

---

## 12. 当前实现的成熟度判断

如果用工程语言描述，当前状态可以认为是：

### 已经收敛的部分

- canonical conversation timeline
- source-aware prompt injection
- snapshot + delta 召回骨架
- 与 memory 的边界
- synthetic context 不回写 timeline

### 还可以继续演进的部分

- snapshot 的语义精度
- 自动关联策略
- 未来可能的 conversation-level locking
- 更强的结构化 side effects 表达

---

## 13. 一个重要事实：当前 snapshot 抽取仍是启发式规则

目前 `objective / open_loops / constraints / decisions` 的提取是规则型、低成本实现。

这意味着：

- 优点：稳定、便宜、无额外模型成本、易于调试
- 缺点：语义精度有限，不能完全理解复杂上下文

这不是架构问题，而是抽取器精度问题。

当前设计刻意先稳定 schema，再考虑未来升级抽取器。

后续如果要升级，推荐做法是：

```text
raw timeline
  -> rule snapshot (fallback)
  -> model-assisted snapshot compiler (higher quality)
```

也就是说：

- schema 和下游消费方式不要再轻易改
- 以后只替换 snapshot compiler 的实现

---

## 14. 后续开发建议

### 14.1 推荐优先做的

- 提升 snapshot 抽取质量
- 增加 side effects / artifacts 级别的信息
- 增加更明确的 current objective 更新规则

### 14.2 谨慎再做的

- 更激进的自动关联
- guest 继承 owner 上下文
- timeline 中写入派生上下文

### 14.3 目前不建议做的

- 让所有渠道共用一个 transcript
- 再回到用户前缀注入
- 把 conversation context 直接并入 memory 流水线作为唯一来源

---

## 15. 维护约定

未来改这部分时，请默认遵守以下约定：

1. canonical timeline 必须保持原始事实优先，不写入 synthetic 派生上下文
2. 共享上下文必须保留来源标签，不能丢失 channel attribution
3. 不要让跨渠道上下文伪装成当前渠道用户输入
4. memory 与 conversation context 必须继续保持目录级和职责级隔离
5. snapshot schema 可以扩展，但尽量不要频繁改字段语义
6. 如果引入模型参与 snapshot 抽取，应保留规则兜底路径

---

## 16. 一句话总结

当前多频道上下文方案的核心不是“共享聊天记录”，而是：

> 用 canonical conversation timeline 保存同一逻辑会话的跨渠道事实，
> 用 snapshot + delta 召回运行上下文，
> 同时保持 transcript、memory、channel attribution 三者边界清晰。

