# Board — 架构设计文档

> 版本：0.1-draft | 最后更新：2026-03-17

---

## 一、核心定位

Board 承接这一段：

```
任意输入（LLM 回复 / 工具结果 / 用户消息）
        ↓
[ Board Runtime ]
· 触发 .board script 钩子
· 响应式状态更新
· 渲染 <template>
        ↓
任意输出（由 .board <template> 定义）
```

**Board 不管**：LLM 调用、HTTP 连接、对话循环。这些由调用方自己做。

**输入/输出格式**：完全由使用方在 .board 文件里定义，Board 不预设任何 schema。

---

## 二、.board 文件结构

```board
<template>
  <!-- 声明输出结构，响应式绑定 script 中的状态变量 -->
  {{ result }}
</template>

<script>
// JS 钩子逻辑
let result = ''
let activeTools = []

on('update', (input) => {
  // 处理输入，更新响应式状态
  // 状态变化 → template 自动重新渲染
})
</script>

<config>
# YAML 配置
# 工具声明、模型参数等
</config>
```

`.board` 文件 = 单文件组件（SFC），设计参考 Vue SFC。
**同一文件**同时承担：skill 定义 + 请求组装逻辑 + 状态管理。

---

## 三、动态工具加载设计

### 问题

Board 接管了所有 tool_call，AI 无法通过"调工具"来切换工具集。
工具按需加载必须是 .board 文件内部的机制。

### 方案：Config 全量声明 + Script 响应式控制

```board
<script>
let activeTools = []

on('update', (input) => {
  // 根据上下文动态决定暴露哪些工具
  if (input.task === 'coding') {
    activeTools = toolsByGroup('coding')
  } else if (input.task === 'research') {
    activeTools = toolsByGroup('research')
  }
})
</script>

<config>
tools:
  - name: web_search
    description: 搜索网络
    handler: webSearch
    group: research
    parameters:
      query: { type: string }

  - name: code_executor
    description: 执行代码
    handler: execCode
    group: coding
    parameters:
      code: { type: string }

toolSelection:
  mode: dynamic        # static | dynamic | mcp
  binding: activeTools # 绑定到响应式变量
</config>
```

**设计要点：**
- Config 声明全量工具池（schema 定义）
- Script 中 `activeTools` 响应式变量控制当前轮实际暴露给 LLM 的子集
- Template 渲染时，`tools` 字段只输出 `activeTools` 中的工具
- 工具加 `group` 标签，Runtime 提供 `toolsByGroup()` 便捷 API

### 子组件作为工具集（条件加载）

```board
<include src="./tools/coding-tools.board" />
<include src="./tools/research-tools.board" :if="needsResearch" />
```

条件引入子组件 = 按需加载工具集，与 Board 组件化设计一致。

### MCP 扩展（预留）

```yaml
toolSelection:
  mode: mcp
  endpoint: http://localhost:3001/mcp
```

---

## 四、skill 机制

`.board` 文件本身就是 skill：
- AI 创建/修改 `.board` 文件 → 定义新的 skill
- Runtime 监听文件变化，自动热更新，无需重启
- AI 通过修改 `.board` 文件来改变自己的行为，而不是调用外部命令

**这是 Board 与传统 skill 框架的根本区别：**

| | 传统 skill（SKILL.md） | Board skill（.board） |
|--|--|--|
| 内容 | 静态 Markdown，人写 | 动态模板 + JS 逻辑，AI 可写 |
| 工具 | 静态注册 | 响应式按需加载 |
| 更新方式 | 人工编辑 | AI 运行时写文件，热更新生效 |
| 状态 | 无 | 响应式状态贯穿整个会话 |

---

## 五、SDK 接口

```js
import { createBoard } from '@board/core'

const board = await createBoard('./main.board', { watch: true })

// 核心接口：任意输入 → 渲染输出
const output = await board.update(input)

// 切换 .board 文件
await board.load('./other.board')

// 调试
board.getState()

// 清理
await board.destroy()
```

---

## 六、业界参考对比

| 框架 | 动态工具加载方式 |
|------|----------------|
| LangGraph | 图节点级工具绑定，不同节点可见不同工具子集 |
| Mastra | Runtime Context 依赖注入，运行时注入不同 toolset |
| Genkit | `dynamicTool()` 运行时动态创建工具 |
| VoltAgent | Supervisor/sub-agent 层级路由工具分发 |
| MCP | 标准协议，运行时向 Server 查询可用工具 |
| **Board** | Config 全量声明 + Script 响应式控制可见子集 |

Board 将"注册表 + 过滤"模式内化到 .board 文件自身，保持单文件自洽。

---

## 七、待解决问题

- [ ] renderer 返回格式解耦（当前硬编码 `{ system, messages, tools }`，应由 template 决定）
- [ ] `toolsByGroup()` Runtime API 实现
- [ ] `toolSelection.mode: dynamic` 的 binding 机制实现
- [ ] `<include>` 条件加载子组件实现
- [ ] runtimeMemory：工具结果注入为当前轮 context 但不进历史的机制
