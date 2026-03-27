# Board Language Specification

> Version: 0.2.1

## 1. 核心理念

Board 是一个**通用响应式上下文引擎**。

```
任意输入（LLM 回复、工具结果、用户消息……）
        ↓ board.update(input)
┌───────────────────────────┐
│       Board Runtime       │
│                           │
│  .board 文件定义的状态机  │
│  · script on() 钩子处理输入│
│  · 响应式状态更新         │
│  · template 重新渲染      │
│                           │
└───────────────────────────┘
        ↓ 输出
{ 任意结构，由 <template> 决定 }
```

**Board 不预设任何输入/输出格式。** 输入格式由 `on('update')` 钩子处理，输出格式由 `<template>` 的顶层标签结构决定。

AI 可以在运行时新建或修改 `.board` 文件，**文件变化自动热更新**，无需重启、无需注册、无需新 session。

---

## 2. 文件结构

一个 `.board` 文件由三个块组成：

```board
<template>
  <!-- 声明输出结构 -->
  <!-- 顶层标签名即为输出对象的 key，可以自由定义 -->
  <!-- 支持变量插值，响应式绑定 script 中的状态 -->
</template>

<script>
// 普通 Node.js / ESM JavaScript
// 处理输入、维护状态、控制 context 分流
</script>

<config>
# YAML
# model、tools 等参数（可选）
</config>
```

---

## 3. Template 块

Template 描述**输出结构**。顶层标签名自由定义，最终编译为：

```js
{
  // 每个顶层标签成为输出对象的一个 key
  // 格式由模板结构决定，没有硬编码约束
}
```

### 3.1 自由定义输出结构

```board
<template>
  <system>
    You are {{ role }}.
  </system>

  <messages>
    <!-- 包含 <message> 节点 → 渲染为 [{ role, content }] 数组 -->
    {{ history }}
    <message role="user">{{ userInput }}</message>
  </messages>

  <tools>
    <!-- 单个插值且为对象/数组 → 直接保留类型 -->
    {{ activeTools }}
  </tools>

  <!-- 自定义 section：任意名称均可 -->
  <context>
    {{ contextSummary }}
  </context>
</template>
```

渲染结果示例：
```js
{
  system: "You are ...",
  messages: [{ role: 'user', content: '...' }],
  tools: [...],
  context: "..."
}
```

### 3.2 渲染类型推断

每个 section 根据内容自动推断返回类型：

| 情况 | 渲染结果 |
|------|---------|
| 单个 `{{ expr }}` 且值为对象/数组 | 直接返回，保留原始类型 |
| 包含 `<message>` 节点 | `[{ role, content }]` 数组 |
| 其余（文本、插值混合等） | 字符串 |

### 3.3 无 section 的简洁写法

```board
<template>
  {{ result }}
</template>
```

输出直接是 `result` 的值（不包裹为对象）。

### 3.4 响应式插值

```board
{{ variable }}        <!-- script 中的变量，变了自动更新 -->
{{ expr.method() }}   <!-- JS 表达式 -->
```

### 3.5 条件与循环

```board
<if :condition="hasContext">
  Background: {{ contextSummary }}
</if>

<each :items="toolResults" :as="r">
  - {{ r.name }}: {{ r.output }}
</each>
```

### 3.6 文件嵌入

```board
<include src="./prompts/base.txt" />
```

路径相对于 `.board` 文件。在 `<messages>` section 内使用时，内容作为 `user` 消息插入。

支持动态路径（`:src="expr"`），表达式在当前 state 上下文中求值：

```board
<include :src="`./prompts/${lang}-instructions.txt`" />
```

支持条件嵌入（`:if="expr"`），条件为 falsy 时跳过文件加载：

```board
<include :if="advancedMode" src="./prompts/advanced.txt" />
```

`:if` 和 `:src` 可以组合使用：

```board
<include :if="lang !== 'en'" :src="`./prompts/${lang}-instructions.txt`" />
```

### 3.7 message 节点

```board
<messages>
  {{ history }}
  <message role="user">{{ userInput }}</message>
  <message role="assistant">{{ lastReply }}</message>

  <!-- 简写形式 -->
  <user>{{ userInput }}</user>
  <assistant>{{ lastReply }}</assistant>
</messages>
```

---

## 4. Script 块

标准 Node.js ESM。Board 注入生命周期 API 和 context 分流 API。

### 4.1 生命周期钩子

```js
on('mount', () => {
  // .board 文件被加载（或热更新后）触发
  role = inject('agent_role') ?? 'assistant'
})

on('update', (input) => {
  // board.update(input) 时触发
  // input 格式由使用方自己决定
  userInput = input.message ?? ''
})

on('destroy', () => {
  // board.destroy() 时触发，清理资源
})

on('emit:eventName', (payload) => {
  // emit('eventName', payload) 时触发
})
```

| 钩子 | 触发时机 |
|------|---------|
| `on('mount', fn)` | 文件加载/热更新后 |
| `on('update', fn)` | 每次 `board.update(input)` |
| `on('destroy', fn)` | `board.destroy()` |
| `on('emit:name', fn)` | `emit('name', payload)` |

### 4.2 Context 分流

```js
on('update', (input) => {
  session('userId', input.userId)  // 整个 session 保留
  history(input.summary)           // 进历史消息
  turn(input.rawData)              // 只这一轮用，下轮丢弃
  drop(input.debugInfo)            // 直接丢弃
})
```

| API | 生命周期 | 说明 |
|-----|---------|------|
| `session(key, value)` | session 全程 | 存入 KV 存储，整个对话可访问 |
| `session({ key: value })` | session 全程 | 批量写入 |
| `inject(key)` | — | 读取 session 存储的值 |
| `history(data, opts?)` | 进历史记录 | `opts`: `{ role, priority }` |
| `turn(data, opts?)` | 仅当前轮 | 注入当前渲染上下文，下轮自动丢弃 |
| `drop(data)` | 立即丢弃 | 不进任何地方，语义明确 |
| `emit(event, payload)` | — | 触发命名事件 |

### 4.3 响应式状态

`<script>` 中用 `let`/`const`/`var` 声明的变量自动变为响应式状态：

```js
let role = 'assistant'
let userInput = ''
let history = []

on('update', (input) => {
  userInput = input.content  // 修改状态 → template 自动重渲染
})
```

### 4.4 Tool Registry（动态工具加载）

在 `<config>` 中声明工具后，script 里可以使用工具查询 API：

```yaml
# <config>
tools:
  - name: search
    description: Search the web
    group: default
  - name: code_exec
    description: Execute code
    group: [default, advanced]
  - name: diagram
    description: Generate diagrams
    group: advanced
```

```js
// Script 中可用的工具 API
let activeTools = []

on('update', (input) => {
  // 按 group 过滤（多个 group 取并集）
  activeTools = toolsByGroup('default')           // → [search, code_exec]
  activeTools = toolsByGroup('default', 'advanced') // → [search, code_exec, diagram]

  // 按名称查找
  activeTools = toolsByName('search', 'diagram')  // → [search, diagram]

  // 获取全部
  activeTools = allTools()                         // → [search, code_exec, diagram]
})
```

`group`、`handler` 等内部字段**自动从结果中剥离**，返回的 schema 可以直接传给 LLM。

| API | 说明 |
|-----|------|
| `toolsByGroup(...groups)` | 返回属于任意指定 group 的工具（并集） |
| `toolsByName(...names)` | 返回指定名称的工具 |
| `allTools()` | 返回全部工具 |

### 4.5 Runtime Memory（跨轮持久内存）

与 `session()` 不同，runtime memory 完全由使用方手动管理，不会在轮次之间自动清除。

```js
on('update', (input) => {
  // 存储
  memory('lastInput', input.message)
  memory('screenshot', input.imageKey)

  // 读取
  const prev = getMemory('lastInput')    // 读取单个 key
  const all  = getMemory()               // 读取全部（浅拷贝）

  // 删除
  memory('screenshot', null)             // 传 null/undefined 删除
})
```

`getMemory` 也可在 template 表达式中使用：

```board
<template>
  <system>Last tool group: {{ getMemory('lastToolGroup') }}</system>
</template>
```

| API | 说明 |
|-----|------|
| `memory(key, value)` | 存储（`null`/`undefined` 为删除） |
| `getMemory(key?)` | 读取单个 key，或无参时返回全部的浅拷贝 |

### 4.6 完整 JS 生态

Script 块支持完整的 Node.js ESM，可以直接使用内置模块和 npm 包（项目需要自行安装依赖）。

---

## 5. Config 块

YAML 格式，声明元信息和请求参数：

```yaml
model: gpt-4o
max_tokens: 4000
temperature: 0.7

name: MainAssistant
description: 主助手组件，处理通用对话
```

Config 内容通过 `ast.config` 暴露，使用方可以在创建 Board 后读取并传给 LLM API。

---

## 6. SDK API

```js
import { createBoard } from '@board/core'

// 创建并启动
const board = await createBoard('./main.board', {
  watch: true,   // 监听文件变化，自动热更新（默认 true）
})

// 核心接口：任意输入 → template 渲染结果
const output = await board.update(input)

// 运行时切换 .board 文件
await board.load('./other.board')

// 读取当前响应式状态（调试用）
board.getState()

// 读取 context（{ history, session, turn, memory }，调试用）
board.getContext()

// 裁剪历史，保留最近 N 条（低优先级先移除）
board.trimHistory(20)

// 从外部触发命名事件（script 通过 on('emit:name', fn) 监听）
await board.emit('name', payload)

// 从外部监听运行时事件或 emit 事件
board.on('emit:name', (payload) => { /* ... */ })

// 移除具体监听器；不传 fn 时移除该事件的所有监听器
board.off('emit:name', handler)
board.off('emit:name')

// 停止，清理资源（幂等）
await board.destroy()
```

---

## 7. Runtime 工作流

```
board.update(input)
  ↓
触发 on('update', input) 钩子
  ↓
script 处理 input，更新响应式状态
（格式完全由使用方决定）
  ↓
_render(): 遍历 template sections，渲染每个 section
  ↓
返回 { [sectionName]: renderedValue, ... }
（结构由 template 决定）
  ↓
flushTurn(): 清空 turn 数据
```

Board 不执行工具，不调用 LLM，不假设输入/输出格式。工具执行和 LLM 调用由使用方在 `on('update')` 钩子之前处理，结果以任意格式传给 `board.update()`。

---

## 8. 多实例模型

每个 `.board` 根组件实例是一个**独立的流程单元**：

- 拥有独立的状态空间，实例之间完全隔离
- 跨实例通信通过显式的 `emit` / `on('emit:xxx')` 接口进行
- 组件复用通过子组件 `<include>` 实现，不是实例共享

---

## 9. 已定设计决策

| # | 问题 | 决策 |
|---|------|------|
| 1 | 输入/输出 schema | 不预设，完全由使用方在 .board 文件中定义 |
| 2 | 工具执行 | 使用方自己调用，结果以任意格式传给 `board.update()` |
| 3 | history 超量裁剪 | `history(data, { priority: 'low' })` 声明优先级，低优先级先截断；或调用 `board.trimHistory(n)` |
| 4 | session 数据存储 | ContextManager 内存存储；跨 session 持久化由使用方自行处理 |
| 5 | 多实例并存 | 进程级隔离，跨实例用 emit/on |
| 6 | AI 生成组件安全沙箱 | 初期不做，config 预留 `sandbox: true` 字段 |
| 7 | template 顶层标签 | 完全自由，无硬编码限制 |
