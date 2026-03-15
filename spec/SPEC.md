# Promptu Language Specification

> Version: 0.2.0-draft

## 1. 核心理念

Promptu 是一个运行在 Agent 框架内的**请求组装状态机**。

```
LLM 回复（含工具结果）
        ↓ 输入
┌───────────────────────────┐
│      Promptu Runtime      │
│                           │
│  .ptu 文件定义的状态机    │
│  · script 处理输入/维护状态│
│  · template 声明请求结构  │
│  · 响应式：状态变 → 请求变│
│                           │
└───────────────────────────┘
        ↓ 输出
{ system, messages, tools }
        ↓
      LLM API
```

**一句话：ptu 项目接管了 Agent 框架原本负责组装 LLM 请求的部分。**

AI 可以在运行时新建或修改 `.ptu` 文件，**文件变化自动接入当前状态机**，无需重启、无需注册、无需新 session。这是 AI 自驱动迭代的基础。

---

## 2. 文件结构

一个 `.ptu` 文件由三个块组成：

```ptu
<template>
  <!-- 声明 LLM 请求的内容结构 -->
  <!-- 支持变量插值，响应式绑定 script 中的状态 -->
</template>

<script>
// 普通 Node.js / ESM JavaScript
// 处理输入、维护状态、控制 context 分流
</script>

<config>
# YAML
# model、tools 等请求参数
</config>
```

---

## 3. Template 块

Template 描述的是**整个 LLM 请求的内容**，最终编译为：

```js
{
  system: "...",   // <system> 块
  messages: [...], // <messages> 块 + 当前 <user> 块
  tools: [...]     // 来自 <config>
}
```

### 3.1 三个内容区

```ptu
<template>
  <system>
    You are {{ role }}.
    {{ extraContext }}
  </system>

  <messages>
    <!-- 声明历史消息怎么带，带多少 -->
    {{ history.last(10) }}
    <!-- 或者完全自定义 -->
    <each :items="selectedMessages" :as="msg">
      <message :role="msg.role">{{ msg.content }}</message>
    </each>
  </messages>

  <user>
    {{ currentInput }}
  </user>
</template>
```

- `<system>` → 请求的 system prompt
- `<messages>` → 历史消息列表，AI 完全控制带什么、带多少
- `<user>` → 当前轮用户消息

### 3.2 响应式插值

```ptu
{{ variable }}        <!-- script 中的变量，变了自动更新 -->
{{ expr.method() }}   <!-- JS 表达式 -->
```

### 3.3 子组件嵌入

```ptu
<include src="./tool-context.ptu" :data="activeTools" />
```

子组件渲染结果内联到当前位置。

### 3.4 条件与循环

```ptu
<if :condition="hasContext">
  Background: {{ contextSummary }}
</if>

<each :items="toolResults" :as="r">
  - {{ r.name }}: {{ r.output }}
</each>
```

---

## 4. Script 块

标准 Node.js ESM。Promptu 在此基础上注入生命周期 API 和 context 分流 API。

### 4.1 Context 分流

工具返回结果后，AI 声明每块数据的去向：

```js
import { turn, history, session, drop } from '@promptu/context'

on('tool_response', (result) => {
  session(result.user_id)      // 整个 session 保留
  history(result.summary)      // 进历史消息
  turn(result.raw_data)        // 只这一轮用，下轮丢弃
  drop(result.debug_info)      // 直接丢弃，不进任何地方
})
```

| API | 生命周期 | 说明 |
|-----|---------|------|
| `session(data)` | session 全程 | 存入 session 存储，整个对话可访问 |
| `history(data)` | 进历史记录 | 进入 messages 历史，可被 template 引用 |
| `turn(data)` | 仅当前轮 | 注入当前请求，下轮自动丢弃 |
| `drop(data)` | 立即丢弃 | 不进任何地方 |

### 4.2 生命周期钩子

```js
on('message', (input) => {
  // 用户消息到来
  currentInput = input.content
})

on('tool_response', (result) => {
  // 工具执行完毕，处理结果
})

on('llm_response', (response) => {
  // LLM 非工具调用回复
})

on('mount', () => {
  // 此 .ptu 文件被加载/更新时触发
})
```

### 4.3 响应式状态

script 块中用 `let` 声明的变量自动响应式，变化时触发 template 重新渲染：

```js
let role = 'assistant'
let currentInput = ''
let history = []

on('message', (input) => {
  currentInput = input.content  // 自动触发 template 更新
})
```

### 4.4 组件通信

```js
// 接收父组件或 session 注入的数据
inject('user')
inject('activeTools')

// 向外抛出事件
emit('result', payload)
```

### 4.5 完整 JS 生态

```js
// 任何 Node.js 内置模块
import { readFile } from 'fs/promises'
import path from 'path'

// 任何 npm 包
import axios from 'axios'
import { z } from 'zod'

// 其他 .ptu 组件
import ToolPanel from './tool-panel.ptu'

// 已有业务脚本直接复用
import { parseResult } from './tools/parser.js'
```

---

## 5. Config 块

YAML 格式，声明请求参数：

```yaml
model: gpt-4o
max_tokens: 4000
temperature: 0.7

# 可用工具列表（影响请求的 tools 字段）
tools:
  - web_search
  - code_executor
  - file_read

# 组件元信息
name: MainAssistant
description: 主助手组件，处理通用对话
```

---

## 6. 项目结构

```
my-agent/
├── promptu.config.js   # 项目入口配置
├── main.ptu            # 默认激活的根组件
├── search.ptu          # 搜索场景组件
├── code.ptu            # 代码场景组件
├── components/
│   ├── tool-panel.ptu  # 可复用子组件
│   └── history.ptu
└── tools/
    ├── search.js       # 普通 JS 工具脚本
    └── parser.js
```

### 6.1 文件即接入

Runtime 监听项目目录。任何 `.ptu` 文件的新建或修改：
- 立即解析并注册到状态机
- 当前 session 下一轮请求即可使用
- 无需重启，无需注册，无需新 session

**这是 AI 自驱动的核心机制。** AI 写完 `.ptu` 文件，下一轮就生效。

### 6.2 入口配置

```js
// promptu.config.js
export default {
  entry: './main.ptu',         // 默认入口组件
  watchDir: './',              // 监听目录
  context: {
    sessionStore: 'memory',    // session 存储方式
    historyLimit: 50,          // 默认最大历史条数
  }
}
```

---

## 7. Runtime 工作流

```
1. 启动：加载 promptu.config.js，激活 entry 组件
2. 监听：watch 项目目录，.ptu 变化立即重新加载
3. 每轮：
   a. 接收输入（用户消息 / 工具结果 / LLM 回复）
   b. 触发对应 on() 钩子
   c. script 运行，状态更新
   d. template 响应式重新渲染
   e. 输出 { system, messages, tools }
4. 发送给 LLM API
5. 回到第 3 步
```

---

## 8. 与 Skill 机制的关系

| | Skill (现在) | Promptu |
|--|------------|---------|
| 定义方式 | Markdown 自然语言 | 代码声明 |
| 工具调用 | AI 读描述后自行决定 | script 里直接 import/调用 |
| 请求控制 | 无法控制 | 完全控制 system/messages/tools |
| context 管理 | 无法声明 | turn/history/session/drop |
| 运行时更新 | 需要新 session | 文件变化即时生效 |
| AI 自创建 | 写 SKILL.md，下个 session 生效 | 写 .ptu，当前 session 立即生效 |

Promptu 不是替换工具调用本身，而是替换**请求组装这一层**，让 AI 对整个请求有完整控制权。

---

## 9. 多实例模型

每个 `.ptu` 根组件实例是一个**独立的流程单元**：

- 拥有独立的状态空间，实例之间完全隔离
- 类似操作系统进程：互不影响，不共享内存
- 跨实例通信通过显式的 `emit` / `on` 接口进行
- 组件复用通过子组件 `<include>` 实现，不是实例共享

```
实例A: search.ptu ──emit('result')──┐
                                    ├── 跨实例通信
实例B: code.ptu ────on('result')────┘

实例A 和 实例B 状态完全隔离
```

使用方应保证：一个 `.ptu` 根实例管理一个完整流程。新流程新建实例，可复用子组件但不共享状态。

---

## 10. 已定设计决策

| # | 问题 | 决策 |
|---|------|------|
| 1 | `<messages>` 不写时默认行为 | 带全部历史，显式写才覆盖 |
| 2 | history 超 token 压缩策略 | `history(data, { priority: 'low' })` 声明优先级，低优先级先被截断 |
| 3 | session 数据存储 | 业务侧自行处理，Promptu 只提供语义 API |
| 4 | 多实例并存 | 进程级隔离，跨实例用 emit/on |
| 5 | AI 生成组件安全沙箱 | 初期不做，config 预留 `sandbox: true` 字段 |
