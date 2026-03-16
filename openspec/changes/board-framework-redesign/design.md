# Design: Board Framework Redesign

> 配套提案：board-framework-redesign/proposal.md
> 日期：2026-03-17

---

## 一、SDK 层 API（@board/core）

公开 API 保持不变，语义更明确：

```js
import { createBoard } from '@board/core'

// 创建实例
const board = await createBoard('./main.board', {
  watch: true,       // 热更新（默认 true）
})

// 唯一输入入口：任意输入 → on('update') → 渲染 template → 任意输出
const output = await board.update(input)

// 运行时切换 .board 文件
await board.load('./other.board')

// 调试
board.getState()     // 响应式状态快照
board.getContext()   // context 各层数据

// 清理
await board.destroy()
```

**变化说明：**
- `board.update(input)` 语义不变：触发 `on('update', input)`，返回 template 渲染结果。
- 移除 Runtime 层的 `process()` / `processUserMessage()` — 这些是 LLM 专用接口，不属于通用引擎。
- 使用方如需区分 tool_call / message / exec，在 `.board` 的 `on('update')` 中自行判断。

---

## 二、.board 文件新格式

### 2.1 Template — 自由输出结构

**核心变化：** `<template>` 不再强制 `<system>` / `<messages>` / `<user>` 分区。模板中的顶层自定义标签直接映射为输出对象的 key。

```board
<template>
  <system>
    You are {{ role }}.
    Current task: {{ task }}

    <if :condition="hasRuntimeMemory">
    [Runtime Context]
    {{ runtimeMemory }}
    </if>
  </system>

  <messages>
    <each :items="conversationHistory" :as="msg">
      <message :role="msg.role">{{ msg.content }}</message>
    </each>
  </messages>

  <user>
    {{ currentInput }}
  </user>

  <tools>
    {{ activeTools }}
  </tools>

  <metadata>
    {{ meta }}
  </metadata>
</template>
```

**渲染输出：**
```js
{
  system: "You are a coding assistant.\nCurrent task: ...",
  messages: [...],
  user: "帮我写一个排序函数",
  tools: [...],
  metadata: { ... }
}
```

**规则：**
- 模板中每个顶层标签名 → 输出对象的 key
- 标签内容按已有节点类型渲染（text / interpolation / if / each / include / message）
- 如果模板中没有任何顶层标签，整个内容渲染为字符串直接返回（向后兼容简单用法）
- `<message>` 标签在 `<messages>` 内部使用时，渲染为 `{ role, content }` 对象并收集为数组
- 插值表达式 `{{ expr }}` 的求值结果如果是对象/数组，直接保留类型（不序列化为字符串）

### 2.2 Script — 响应式状态 + 钩子

**钩子精简：** 只保留通用钩子，移除 LLM 专用钩子。

```board
<script>
// ─── 响应式状态 ───────────────────────
let role = 'a coding assistant'
let task = ''
let currentInput = ''
let conversationHistory = []
let activeTools = []
let runtimeMem = {}
let meta = {}

// ─── 生命周期钩子 ─────────────────────

on('mount', () => {
  // .board 文件加载/热更新后触发
  activeTools = toolsByGroup('default')
})

on('update', async (input) => {
  // 唯一的输入处理入口
  // input 是 board.update(input) 传入的任意数据
  // 使用方自行解析格式

  if (input.type === 'user_message') {
    currentInput = input.content
    conversationHistory = [
      ...conversationHistory,
      { role: 'user', content: input.content }
    ]
    // 根据用户意图切换工具子集
    if (input.content.includes('搜索')) {
      activeTools = toolsByGroup('research')
    }
  }

  if (input.type === 'tool_result') {
    const { name, result } = input
    // 精细控制数据去向
    if (name === 'screenshot') {
      // 截图 → runtimeMemory，不进历史
      memory('screenshot', result.image)
    } else {
      // 普通工具结果 → 进历史
      conversationHistory = [
        ...conversationHistory,
        { role: 'tool', content: JSON.stringify(result) }
      ]
    }
  }

  if (input.type === 'llm_response') {
    conversationHistory = [
      ...conversationHistory,
      { role: 'assistant', content: input.content }
    ]
    // LLM 回复后切回默认工具集
    activeTools = toolsByGroup('default')
  }
})

on('destroy', () => {
  // 清理资源
})

// ─── 工具 handler（供使用方在外部调用后传结果进来）───
async function searchHandler(args) {
  // 工具实现
  return { query: args.query, results: ['...'] }
}
</script>
```

**钩子变化：**

| 旧钩子 | 新设计 | 说明 |
|--------|--------|------|
| `on('mount')` | `on('mount')` | 保留 |
| `on('message', ...)` | 移除 | 在 `on('update')` 中自行判断 |
| `on('tool_response', ...)` | 移除 | 在 `on('update')` 中自行判断 |
| `on('llm_response', ...)` | 移除 | 在 `on('update')` 中自行判断 |
| `on('update', ...)` | `on('update', input)` | **唯一的输入处理入口** |
| `on('destroy')` | `on('destroy')` | 保留 |

### 2.3 Script 注入 API

Runtime 注入给 `<script>` 的 API：

```js
// ─── 钩子注册 ─────────────────────
on(event, handler)          // 注册事件处理函数

// ─── Context 分流 ────────────────
turn(data, opts?)           // 当前轮临时数据，下轮自动丢弃
history(data, opts?)        // 进入对话历史
session(key, value?)        // session 级 KV 存储
drop(data)                  // 显式丢弃

// ─── runtimeMemory ───────────────
memory(key, value)          // 注入 runtimeMemory，作为独立 key 存在于输出
memory(key, null)           // 清除某个 runtimeMemory key
getMemory(key?)             // 读取 runtimeMemory

// ─── 工具查询 ────────────────────
toolsByGroup(...groups)     // 按 group 标签查询工具子集
toolsByName(...names)       // 按 name 查询工具子集
allTools()                  // 返回 config 中声明的全量工具

// ─── 组件通信 ────────────────────
emit(event, payload)        // 向外抛出事件
inject(key)                 // 从 session 或父组件获取注入值
```

### 2.4 Config — 带动态工具加载的完整示例

```board
<template>
  <system>
    You are {{ role }}, an AI assistant that can use tools.
    Current mode: {{ mode }}

    <if :condition="hasScreenshot">
    [Screenshot Context]
    {{ getMemory('screenshot') }}
    </if>

    <if :condition="hasWindowInfo">
    [Active Window]
    {{ getMemory('windowInfo') }}
    </if>
  </system>

  <messages>
    <each :items="recentHistory" :as="msg">
      <message :role="msg.role">{{ msg.content }}</message>
    </each>
  </messages>

  <user>
    {{ currentInput }}
  </user>

  <tools>
    {{ activeTools }}
  </tools>
</template>

<script>
let role = 'DeepV Code'
let mode = 'default'
let currentInput = ''
let recentHistory = []
let activeTools = []
let hasScreenshot = false
let hasWindowInfo = false

on('mount', () => {
  activeTools = toolsByGroup('default')
})

on('update', async (input) => {
  // ─── 用户消息 ───────────────────────
  if (input.type === 'user_message') {
    currentInput = input.content
    recentHistory = [...recentHistory, { role: 'user', content: input.content }]

    // 根据用户意图动态切换工具子集
    const intent = detectIntent(input.content)
    if (intent === 'coding') {
      mode = 'coding'
      activeTools = toolsByGroup('coding', 'filesystem')
    } else if (intent === 'research') {
      mode = 'research'
      activeTools = toolsByGroup('research', 'web')
    } else {
      mode = 'default'
      activeTools = toolsByGroup('default')
    }
  }

  // ─── 工具结果 ───────────────────────
  if (input.type === 'tool_result') {
    if (input.name === 'screenshot') {
      // 截图 → runtimeMemory（不进历史，作为独立 context 存在）
      memory('screenshot', input.result)
      hasScreenshot = true
    } else if (input.name === 'get_window_info') {
      memory('windowInfo', input.result)
      hasWindowInfo = true
    } else {
      // 普通工具结果 → 进历史
      recentHistory = [
        ...recentHistory,
        { role: 'tool', content: `[${input.name}] ${JSON.stringify(input.result)}` }
      ]
    }
  }

  // ─── LLM 回复 ──────────────────────
  if (input.type === 'llm_response') {
    recentHistory = [
      ...recentHistory,
      { role: 'assistant', content: input.content }
    ]
    // 每轮 LLM 回复后清除临时 runtimeMemory
    memory('screenshot', null)
    hasScreenshot = false
  }

  // 保持最近 20 条
  if (recentHistory.length > 20) {
    recentHistory = recentHistory.slice(-20)
  }
})

function detectIntent(content) {
  if (/代码|函数|实现|bug|debug/i.test(content)) return 'coding'
  if (/搜索|查找|资料|论文/i.test(content)) return 'research'
  return 'default'
}
</script>

<config>
name: MainAssistant
description: 主助手 Board

tools:
  # ─── default 组 ──────────────────────
  - name: read_file
    description: 读取文件内容
    group: [default, coding, filesystem]
    handler: readFileHandler
    parameters:
      path: { type: string, description: 文件路径 }

  - name: write_file
    description: 写入文件
    group: [coding, filesystem]
    handler: writeFileHandler
    parameters:
      path: { type: string }
      content: { type: string }

  # ─── research 组 ─────────────────────
  - name: web_search
    description: 搜索网络
    group: [research, web]
    handler: webSearchHandler
    parameters:
      query: { type: string }

  - name: fetch_url
    description: 抓取网页内容
    group: [research, web]
    handler: fetchUrlHandler
    parameters:
      url: { type: string }

  # ─── coding 组 ───────────────────────
  - name: run_code
    description: 执行代码
    group: [coding]
    handler: runCodeHandler
    parameters:
      language: { type: string }
      code: { type: string }

  - name: screenshot
    description: 截取屏幕
    group: [default, coding, research]
    handler: screenshotHandler
    parameters:
      region: { type: string, optional: true }

  - name: get_window_info
    description: 获取当前窗口信息
    group: [default]
    handler: getWindowInfoHandler
    parameters: {}

toolSelection:
  mode: dynamic           # static | dynamic
  binding: activeTools    # 绑定到 script 中的响应式变量名
</config>
```

**渲染输出示例（coding 模式、带截图 runtimeMemory）：**

```js
{
  system: `You are DeepV Code, an AI assistant that can use tools.
Current mode: coding

[Screenshot Context]
data:image/png;base64,iVBOR...`,

  messages: [
    { role: "user", content: "帮我修复这个 bug" },
    { role: "assistant", content: "让我看看代码..." },
    { role: "tool", content: "[read_file] {\"content\": \"...\"}" },
    { role: "user", content: "看截图里的报错信息" }
  ],

  user: "看截图里的报错信息",

  tools: [
    { name: "read_file", description: "读取文件内容", parameters: { path: { type: "string" } } },
    { name: "write_file", description: "写入文件", parameters: { path: { type: "string" }, content: { type: "string" } } },
    { name: "run_code", description: "执行代码", parameters: { language: { type: "string" }, code: { type: "string" } } },
    { name: "screenshot", description: "截取屏幕", parameters: { region: { type: "string", optional: true } } }
  ]
}
```

---

## 三、Renderer 新实现思路

### 3.1 设计原则

1. **不预设输出 schema** — 输出结构完全由 `<template>` 中的顶层标签决定。
2. **顶层标签名 = 输出 key** — `<system>` → `output.system`，`<tools>` → `output.tools`，`<foo>` → `output.foo`。
3. **智能类型推断** — 文本渲染为 string；`<messages>` 内的 `<message>` 收集为数组；插值表达式保留原始类型。
4. **turn / runtimeMemory 不由 renderer 注入** — 这些数据通过 script 状态变量进入 template，由 template 自行决定怎么呈现。

### 3.2 渲染流程

```
Template AST
    │
    ├─ 提取顶层标签（section nodes）
    │
    ├─ 逐个渲染 section：
    │   ├─ text node → string 拼接
    │   ├─ interpolation → evalExpr()，保留原始类型
    │   ├─ <if> → 条件渲染
    │   ├─ <each> → 循环渲染
    │   ├─ <message> → { role, content } 对象，收集为数组
    │   └─ <include> → 子组件递归渲染
    │
    └─ 组装输出对象：{ [sectionName]: renderedValue }
```

### 3.3 新 renderTemplate 伪代码

```js
export function renderTemplate(ast, state, ctx, config) {
  if (!ast) return {}

  // ast.sections: [{ name: 'system', nodes: [...] }, { name: 'messages', nodes: [...] }, ...]
  const output = {}

  for (const section of ast.sections) {
    output[section.name] = renderSection(section, state, ctx)
  }

  return output
}

function renderSection(section, state, ctx) {
  // 如果 section 内只有一个 interpolation 且结果是对象/数组 → 直接返回
  if (section.nodes.length === 1 && section.nodes[0].type === 'interpolation') {
    const val = evalExpr(section.nodes[0].expr, state)
    if (val !== null && val !== undefined) return val
  }

  // 如果 section 内有 <message> 节点 → 收集为数组
  if (hasMessageNodes(section.nodes)) {
    return renderAsMessageArray(section.nodes, state, ctx)
  }

  // 默认：渲染为 string
  return renderNodes(section.nodes, state, ctx).trim()
}
```

**关键变化：**
- `renderTemplate` 不再 return `{ system, messages, tools }`，而是根据 template 中的顶层标签动态构建输出。
- `tools` 不再从 `config.tools` 直接取，而是由 template 中的 `<tools>{{ activeTools }}</tools>` 渲染。
- turn 数据不再由 renderer 拼入 messages，而是在 script 中通过状态变量传入 template。

### 3.4 Template AST 新结构

**旧结构（parser 输出）：**
```js
{
  system: Node[],       // <system> 内的节点
  messages: Node[],     // <messages> 内的节点
  user: Node[],         // <user> 内的节点
}
```

**新结构：**
```js
{
  sections: [
    { name: 'system', nodes: Node[] },
    { name: 'messages', nodes: Node[] },
    { name: 'user', nodes: Node[] },
    { name: 'tools', nodes: Node[] },
    { name: 'metadata', nodes: Node[] },
    // ... 任意自定义 section
  ]
}
```

Parser 提取 `<template>` 内所有顶层标签，每个标签成为一个 section。不再硬编码 `system` / `messages` / `user`。

### 3.5 无分区 template 的处理

如果 `<template>` 内没有任何顶层标签（纯文本 + 插值），整个内容渲染为字符串直接返回：

```board
<template>
  {{ result }}
</template>
```

输出：`"some string result"` — 不包在对象里。

---

## 四、ToolRegistry — 工具注册与查询

### 4.1 职责

- 解析 `<config>` 中的 `tools` 声明，建立全量工具池。
- 提供按 group / name 查询子集的 API。
- 不负责工具执行（执行由 .board script 中的 handler 或使用方完成）。

### 4.2 实现

```js
export class ToolRegistry {
  constructor(toolConfigs = []) {
    this._tools = new Map()    // name → toolConfig
    this._groups = new Map()   // group → Set<name>
    this._register(toolConfigs)
  }

  _register(toolConfigs) {
    for (const tool of toolConfigs) {
      this._tools.set(tool.name, tool)
      const groups = Array.isArray(tool.group) ? tool.group : [tool.group ?? 'default']
      for (const g of groups) {
        if (!this._groups.has(g)) this._groups.set(g, new Set())
        this._groups.get(g).add(tool.name)
      }
    }
  }

  // 按 group 查询（支持多组取并集）
  byGroup(...groups) {
    const names = new Set()
    for (const g of groups) {
      for (const name of (this._groups.get(g) ?? [])) {
        names.add(name)
      }
    }
    return [...names].map(n => this._tools.get(n)).map(toToolSchema)
  }

  // 按 name 查询
  byName(...names) {
    return names.map(n => this._tools.get(n)).filter(Boolean).map(toToolSchema)
  }

  // 全量
  all() {
    return [...this._tools.values()].map(toToolSchema)
  }
}

// 输出给 LLM 的 schema（去掉 handler / group 等内部字段）
function toToolSchema(tool) {
  const { handler, group, ...schema } = tool
  return schema
}
```

### 4.3 注入到 Script

Runtime 在执行 `<script>` 时，将 `toolsByGroup` / `toolsByName` / `allTools` 注入为全局函数：

```js
const scriptAPI = {
  // ... 现有 API
  toolsByGroup: (...groups) => runtime._toolRegistry.byGroup(...groups),
  toolsByName: (...names) => runtime._toolRegistry.byName(...names),
  allTools: () => runtime._toolRegistry.all(),
}
```

### 4.4 toolSelection binding 机制

`<config>` 中声明：
```yaml
toolSelection:
  mode: dynamic
  binding: activeTools
```

Renderer 渲染 `<tools>` section 时：
- 如果 `toolSelection.mode === 'dynamic'`，从 `state[config.toolSelection.binding]` 读取当前工具列表。
- 如果 section 内有显式内容（如 `<tools>{{ activeTools }}</tools>`），按正常插值渲染。
- binding 是一个**便捷机制**：当 `<tools>` section 为空时，自动从 binding 变量填充。显式声明优先。

---

## 五、runtimeMemory 机制

### 5.1 与现有 Context API 的关系

| API | 生命周期 | 是否进入 messages 历史 | 用途 |
|-----|---------|----------------------|------|
| `drop(data)` | 立即丢弃 | 否 | 明确不需要的数据 |
| `turn(data)` | 当前轮 | 否（但可被 template 引用） | 临时数据 |
| `history(data)` | 持久 | 是 | 对话历史 |
| `session(k, v)` | session 全程 | 否 | 持久 KV 存储 |
| **`memory(k, v)`** | **手动控制** | **否** | **当前轮 context 注入，不进历史** |

### 5.2 memory() API

```js
// 注入 runtimeMemory
memory('screenshot', imageData)
memory('windowInfo', { title: 'VS Code', pid: 1234 })

// 读取
const img = getMemory('screenshot')

// 清除
memory('screenshot', null)

// 在 template 中使用
// {{ getMemory('screenshot') }}
```

### 5.3 与 turn 的区别

- `turn` 在每轮 flush 时自动清除，`memory` 需要 script 手动清除。
- `turn` 是一个数组（追加），`memory` 是 KV 结构（覆盖写入）。
- `memory` 通过 `getMemory(key)` 在 template 中以独立 key 存在；`turn` 在旧设计中被 renderer 拼入 messages（新设计中 turn 数据也通过状态变量进入 template）。

### 5.4 ContextManager 扩展

```js
export class ContextManager {
  constructor() {
    this._turn = []
    this._history = []
    this._session = {}
    this._memory = {}     // ← 新增
  }

  // runtimeMemory
  memory(key, value) {
    if (value === null || value === undefined) {
      delete this._memory[key]
    } else {
      this._memory[key] = value
    }
  }

  getMemory(key) {
    return key ? this._memory[key] : { ...this._memory }
  }

  // ... 其余方法不变
}
```

---

## 六、Skill 机制 — .board as Skill

### 6.1 核心设计

- 每个 `.board` 文件本身就是一个 skill。
- AI 可以在运行时创建/修改 `.board` 文件。
- Runtime 的文件监听器检测到变化后自动重新加载。
- **工具集切换完全在 .board 文件内部**：通过 `on('update')` 中的条件逻辑 + `toolsByGroup()` 实现。
- AI 不能通过 "调工具" 来切换工具集（Board 接管了所有 tool_call），必须通过修改 `.board` 文件的 script 逻辑来改变行为。

### 6.2 热更新增强

当前实现只监听入口文件。新设计：

```js
// 监听整个目录，检测到任何 .board 文件变化时：
// 1. 如果是入口文件 → 重新加载整个 board
// 2. 如果是 include 的子组件 → 重新加载受影响的部分
// 3. 如果是新文件 → 注册为可用的 skill（可被其他 .board include）
```

### 6.3 board.load() 用于切换 skill

使用方在外部可以通过 `board.load('./new-skill.board')` 切换当前活跃的 board。但更推荐的方式是在 `.board` 内部通过条件 include 实现：

```board
<include src="./skills/coding.board" :if="mode === 'coding'" />
<include src="./skills/research.board" :if="mode === 'research'" />
```

---

## 七、完整数据流

```
使用方代码
    │
    │  board.update(input)   // input: 任意格式
    │
    ▼
┌── Board SDK ──────────────────────────────────┐
│   → runtime._triggerHook('update', input)     │
│   → runtime._render()                         │
│   → return output                              │
└───────────────────────────────────────────────┘
    │
    │  触发 on('update')
    ▼
┌── .board <script> ────────────────────────────┐
│   on('update', (input) => {                   │
│     // 自行解析 input 格式                      │
│     // 更新响应式状态                            │
│     // 调用 memory() / history() 等            │
│     // 调用 toolsByGroup() 切换工具子集         │
│   })                                           │
│                                                │
│   响应式状态变化                                 │
│     ↓                                          │
└───────────────────────────────────────────────┘
    │
    ▼
┌── Renderer ───────────────────────────────────┐
│   renderTemplate(ast, state, ctx, config)     │
│     → 遍历 template AST 的 sections           │
│     → 每个 section 渲染为 output 的一个 key     │
│     → 返回 { [sectionName]: renderedValue }   │
└───────────────────────────────────────────────┘
    │
    ▼
  output: 由 <template> 定义的任意结构
    │
    ▼
使用方拿到 output，自行发送 LLM 请求
```

---

## 八、与旧设计对比总结

| 维度 | 旧设计 | 新设计 |
|------|--------|--------|
| 输出格式 | 固定 `{ system, messages, tools }` | 由 `<template>` 顶层标签定义 |
| Template 结构 | 强制 `<system>` / `<messages>` / `<user>` | 任意自定义标签 |
| 输入处理 | `process()` 预设 LLM 格式 | `on('update')` 自行解析 |
| 工具执行 | Runtime 内置 `_executeTool` | .board script 自行调用 handler |
| 工具加载 | 静态全量 | Config 全量 + Script 动态子集 |
| turn 数据 | renderer 拼入 messages | 通过状态变量进入 template |
| runtimeMemory | 无 | `memory(k,v)` + `getMemory(k)` |
| 钩子 | `message` / `tool_response` / `llm_response` | 统一 `update` |
