# Proposal: Board Framework Redesign

> 提案编号：board-framework-redesign
> 日期：2026-03-17
> 状态：draft

---

## 一、当前架构存在的问题

### 问题 1：Renderer 硬编码输出 schema

**现状：** `renderTemplate()` 固定返回 `{ system, messages, tools }`。template 解析器也将 `<template>` 内部强制拆分为 `<system>` / `<messages>` / `<user>` 三个区域。

```js
// renderer.js — 当前实现
return {
  system,     // ← 硬编码字段
  messages,   // ← 硬编码字段
  tools: config.tools ?? [],  // ← 硬编码字段
}
```

**问题：**
- README 声称 "Board 不预设任何 schema"，但 renderer 用代码预设了 `{ system, messages, tools }` 这个唯一输出格式。
- 使用方无法返回 `{ prompt, context, functions }` 或任何其他结构。
- `<template>` 内部必须用 `<system>`/`<messages>`/`<user>`，而不是由使用方自由定义输出结构。
- 与 SPEC.md（Promptu 规范）高度耦合，spec 定义的是 Promptu 的输出格式，不应该是 Board 框架的硬约束。

**矛盾：** 核心理念"任意输入 → 任意输出"在 renderer 层被否定了。

### 问题 2：Runtime 同时承担「通用引擎」和「LLM 请求组装」两个角色

**现状：** `PromptuRuntime` 既是通用的响应式组件运行时，又内置了 LLM 专用的 `process()`、`processUserMessage()` 方法，假设输入格式是 `{ content, tool_calls }`。

```js
// runtime.js — 当前实现
async process(llmResponse) {
  const { content, tool_calls } = llmResponse  // ← 预设输入格式
  if (content && ...) {
    await this._triggerHook('llm_response', ...)  // ← 预设钩子名
  }
  if (tool_calls && ...) {
    // Runtime 自己执行工具  ← 预设行为
  }
}
```

**问题：**
- `process()` 和 `processUserMessage()` 假设了 OpenAI 格式的输入。
- Runtime 自己执行工具（`_executeTool`），但 Board 的 SDK 层只暴露了 `board.update(input)`，两套入口不一致。
- `on('llm_response')` / `on('tool_response')` / `on('message')` 是 Runtime 预设的钩子名，而非使用方自由定义。

**矛盾：** `board.update(input)` 承诺"接收任意输入"，但 Runtime 层又把输入按 LLM 格式拆解了。

### 问题 3：工具加载是静态的，无运行时控制

**现状：** `<config>` 中的 `tools` 全量声明，`renderTemplate` 返回时直接 `tools: config.tools ?? []`，没有按需筛选机制。

**问题：**
- 无法根据当前对话状态动态控制暴露给 LLM 的工具子集。
- 没有 `toolsByGroup()` API，没有 `toolSelection.mode: dynamic` binding 机制。
- 工具组（group）标签在 config 中可以声明，但 Runtime 不处理它。
- DESIGN.md 描述了完整的动态工具加载方案，但代码完全没有实现。

### 问题 4：缺少 runtimeMemory 机制

**现状：** `turn()` API 把数据存入 `_turn` 数组，renderer 在渲染时将 turn 数据统一拼成一条 `{ role: 'tool', content: ... }` 消息追加到 messages 末尾。

```js
// renderer.js — 当前实现
const turnData = ctx.getTurnData()
if (turnData.length > 0) {
  messages = [...messages, {
    role: 'tool',
    content: turnData.map(d => ...).join('\n')
  }]
}
```

**问题：**
- turn 数据被 renderer 强制按 `role: 'tool'` 格式拼入 messages。这又是一个硬编码 schema 的体现。
- 缺少 runtimeMemory 概念：某些工具结果（如截图、窗口信息）应作为当前轮 context 注入输出，但不参与历史记录拼接，也不应该被 renderer 自作主张地格式化为 messages。
- turn 数据的呈现方式应该由 `<template>` 决定，不应该由 renderer 代劳。

### 问题 5：Skill 机制缺少实现路径

**现状：** DESIGN.md 描述了 ".board 文件本身就是 skill"、"AI 可以创建/修改 .board 文件"、"文件热更新无需重启"的设计意图，但缺少几个关键机制：

- Board 接管所有 tool_call 后，AI 无法通过调用工具来切换工具集 — 工具集切换必须在 .board 文件内部声明。但当前没有实现这个"内部声明切换"的机制。
- 文件热更新只监听入口文件，不处理运行时新增的 .board 文件。
- 没有 board-as-skill 的发现和注册机制。

---

## 二、新架构设计

### 核心原则

1. **Board 是一个通用的响应式模板引擎**，不预设任何输入/输出 schema。
2. **`<template>` 是唯一的输出定义**，renderer 把 template 渲染成什么，输出就是什么。
3. **`board.update(input)` 是唯一的输入入口**，input 是什么格式由使用方决定，.board 的 `on('update')` 钩子自行解析。
4. **工具是声明式的全量池 + 响应式的运行时子集**，Runtime 提供便捷 API，template 在渲染时读取当前激活的工具列表。
5. **runtimeMemory 是独立于 history 的临时注入层**，数据在输出中以独立 key 存在，生命周期由使用方控制。

### 架构分层

```
┌─────────────────────────────────────┐
│  @board/core — SDK 层               │
│  createBoard() / board.update()     │
│  唯一的公开 API，面向使用方          │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│  @promptu/runtime — 运行时引擎      │
│  • 文件加载 & 热更新                │
│  • Script 执行 & 响应式状态          │
│  • 钩子系统                         │
│  • ContextManager（turn/history/    │
│    session/drop + runtimeMemory）   │
│  • ToolRegistry（全量池 + 动态子集） │
│  • Template 渲染                    │
└────────────┬────────────────────────┘
             │
┌────────────▼────────────────────────┐
│  @promptu/parser — 解析器           │
│  • .board SFC 解析                  │
│  • Template AST（通用节点树，       │
│    不预设 system/messages/user）     │
│  • Config YAML 解析                 │
│  • Script 提取                      │
└─────────────────────────────────────┘
```

### 各层职责边界

#### @board/core — SDK 层

| 职责 | 说明 |
|------|------|
| `createBoard(path, opts)` | 创建 Board 实例，启动 Runtime |
| `board.update(input)` | 唯一输入入口：触发 `on('update')` → 渲染 template → 返回结果 |
| `board.load(path)` | 运行时切换 .board 文件 |
| `board.getState()` | 读取当前响应式状态（调试用） |
| `board.destroy()` | 停止 Runtime，清理资源 |

**不做的事：**
- 不解析输入格式（不区分 tool_call / message / exec）
- 不执行工具（留给 .board script 或使用方自行处理）
- 不预设输出 schema

#### @promptu/runtime — 运行时引擎

| 职责 | 说明 |
|------|------|
| 文件加载 | 读取 .board 文件，交给 parser 解析，初始化各组件 |
| 热更新 | 监听目录变化，.board 文件变化立即重新加载 |
| Script 执行 | 在沙箱中执行 `<script>` 块，建立响应式状态 |
| 钩子系统 | 管理 `on()` 注册的事件处理函数 |
| ContextManager | 管理 turn / history / session / drop / runtimeMemory |
| ToolRegistry | 管理全量工具池，提供 `toolsByGroup()` 等查询 API |
| Template 渲染 | 把 template AST + state + context 渲染为**使用方定义的结构** |

**不做的事：**
- 不调用 LLM API
- 不假设输入是 `{ content, tool_calls }` 格式
- 不自己执行工具（`_executeTool` 移除，工具执行由 .board script 中的 handler 负责，或由使用方在 board.update 外部自行处理）

#### @promptu/parser — 解析器

| 职责 | 说明 |
|------|------|
| SFC 解析 | 提取 `<template>` / `<script>` / `<config>` 三块 |
| Template 解析 | 解析为**通用节点树**（不再强制 system/messages/user 分区） |
| Config 解析 | YAML → JS 对象，含 tools schema、toolSelection 配置等 |
| Script 提取 | 原样提取 script 源码，交给 Runtime 执行 |

**关键变化：** Template 解析不再预设 `<system>` / `<messages>` / `<user>` 分区结构。这些标签可以存在（作为约定），但 parser 不强制要求，renderer 也不依赖它们。

---

## 三、关键设计决策

### 决策 1：移除 `process()` 和 `processUserMessage()`

这两个方法预设了 LLM 请求/响应格式，违反 "Board 不预设 schema" 原则。

**替代方案：** 使用方在 `.board` 的 `on('update')` 钩子中自行解析输入。如果输入恰好是 `{ tool_calls: [...] }`，则在 script 中调用对应的 handler。Board 框架不需要知道这件事。

### 决策 2：Renderer 渲染 template AST 为通用结构

Renderer 不再返回固定的 `{ system, messages, tools }`。它把 template AST 渲染为 template 自身定义的结构。

**实现思路：** template 中的顶层标签名直接成为输出对象的 key。

### 决策 3：工具执行由 .board script 负责

Runtime 不再内置 `_executeTool`。工具执行完全在 `.board` 的 `<script>` 中完成：script import handler 函数，在 `on('update')` 中判断输入是否为 tool_call 并调用 handler。

这样 Board 真正只是一个「响应式模板引擎」，工具执行是 .board 文件的业务逻辑，不是框架功能。

### 决策 4：runtimeMemory 作为 ContextManager 的新生命周期

与 turn（当前轮注入 + 自动丢弃）不同，runtimeMemory 的特征是：
- 由 script 显式注入
- 在 template 中以独立 key 存在
- 不参与 history 拼接
- 可跨多轮存在，由 script 控制清除

### 决策 5：toolSelection binding 机制

Config 中 `toolSelection.binding` 指向 script 中的响应式变量。Renderer 渲染时，通过该变量名从 state 中读取当前激活的工具列表。这样工具子集的切换完全由 script 的响应式逻辑驱动。

---

## 四、影响范围

| 包 | 变化程度 | 主要改动 |
|----|---------|---------|
| `@promptu/parser` | 中等 | template 解析不再强制 system/messages/user 分区 |
| `@promptu/runtime` | 大 | 移除 process/processUserMessage；renderer 重写；新增 ToolRegistry；ContextManager 新增 runtimeMemory |
| `@board/core` | 小 | Board 类接口不变，内部调用调整 |
| `spec/SPEC.md` | 需更新 | 反映新的 template 自由格式设计 |
| `spec/DESIGN.md` | 需更新 | 补充完整的动态工具加载和 runtimeMemory 设计 |

---

## 五、向后兼容性

当前项目处于 0.1.0 早期开发阶段，无外部用户。本次重设计为 breaking change，不需要做迁移层。

已有的测试文件（`runtime.test.js`、`parser.test.js`）需要同步更新。
