# Tasks: Board Framework Redesign

> 配套提案：board-framework-redesign/proposal.md
> 配套设计：board-framework-redesign/design.md
> 日期：2026-03-17

---

## 优先级说明

- **P0** — 阻塞其他工作，必须先完成
- **P1** — 核心功能，构成新架构的骨架
- **P2** — 重要功能，完善新架构
- **P3** — 增强功能，可后续迭代

---

## P0 — 基础设施（Parser 层改造）

### T01: Template 解析器改为通用 sections 结构

**文件：** `packages/parser/src/template.js`

**当前行为：** `parseTemplate()` 硬编码提取 `<system>` / `<messages>` / `<user>` 三个区域，返回 `{ system, messages, user }`。

**目标行为：** 提取 `<template>` 内所有顶层标签作为 sections，返回 `{ sections: [{ name, nodes }] }`。不再预设任何标签名。

**具体改动：**
1. 移除 `extractSection()` 中的硬编码标签名。
2. 实现通用的顶层标签扫描：遍历 `<template>` 内容，识别所有顶层标签（包括自定义标签），每个标签成为一个 section。
3. 返回 `{ sections: [...] }` 格式。
4. 无标签 template（纯文本 + 插值）：返回 `{ sections: [], rawNodes: Node[] }`。
5. 更新 `TemplateAST` 类型定义。

**验收标准：**
- `parseTemplate('<system>...</system><tools>{{ t }}</tools>')` → `{ sections: [{ name: 'system', ... }, { name: 'tools', ... }] }`
- 自定义标签 `<foo>bar</foo>` 也能被正确提取
- 无标签 template `{{ result }}` → `{ sections: [], rawNodes: [...] }`

---

### T02: 更新 parser.test.js

**文件：** `packages/parser/test/parser.test.js`

**具体改动：**
1. 更新测试用例，验证新的 sections 结构。
2. 新增测试用例：自定义标签、无标签 template、混合标签。
3. 确保旧的 `<system>/<messages>/<user>` 标签仍然可用（只是不再是唯一选项）。

---

## P0 — 核心改造（Renderer + Runtime）

### T03: Renderer 重写 — 基于 sections 的通用渲染

**文件：** `packages/runtime/src/renderer.js`

**当前行为：** `renderTemplate()` 固定返回 `{ system, messages, tools }`，turn 数据被拼入 messages。

**目标行为：** 遍历 AST 的 sections，每个 section 渲染为输出对象的一个 key。不再注入 turn 数据，不再从 config 取 tools。

**具体改动：**
1. 重写 `renderTemplate(ast, state, ctx, config)` 主函数：
   - 遍历 `ast.sections`
   - 每个 section 调用 `renderSection()` 得到渲染结果
   - 组装 `{ [sectionName]: renderedValue }` 返回
2. 实现 `renderSection()` — 智能类型推断：
   - 单个 interpolation 且结果为对象/数组 → 直接返回（保留类型）
   - 包含 `<message>` 节点 → 收集为 `[{ role, content }]` 数组
   - 其余 → 渲染为 string
3. 处理无 section template：直接渲染 rawNodes 返回字符串。
4. 删除 renderer 中所有对 turn 数据和 config.tools 的硬编码注入。

**验收标准：**
- `<system>text</system><tools>{{ arr }}</tools>` → `{ system: "text", tools: [...] }`
- `<custom>{{ obj }}</custom>` → `{ custom: { ... } }`（保留对象类型）
- `{{ "hello" }}` → `"hello"`（无 section 直接返回）

---

### T04: Runtime 移除 LLM 专用方法

**文件：** `packages/runtime/src/runtime.js`

**具体改动：**
1. **删除** `process(llmResponse)` 方法。
2. **删除** `processUserMessage(userMessage)` 方法。
3. **删除** `_executeTool(toolCall)` 方法。
4. **删除** `_registerToolHandlers()` 方法及 `this._toolHandlers` 属性。
5. 保留 `_triggerHook()` / `_render()` / `_loadFile()` / `start()` / `stop()` / `getState()` / `getContext()`。
6. 确保 `board.update(input)` → `_triggerHook('update', input)` → `_render()` 的路径正常工作。

**验收标准：**
- `board.update(anyInput)` 触发 `on('update', anyInput)`，返回 template 渲染结果。
- 无 `process` / `processUserMessage` 方法存在。

---

### T05: 更新 runtime.test.js

**文件：** `packages/runtime/test/runtime.test.js`

**具体改动：**
1. 移除对 `process()` / `processUserMessage()` 的测试。
2. 所有测试通过 `board.update(input)` 入口，在 `on('update')` 中自行处理输入。
3. 测试 template 自由输出结构（自定义 section 名）。
4. 测试 `toolsByGroup()` 动态工具切换。
5. 测试 runtimeMemory。

---

## P1 — 动态工具加载

### T06: 实现 ToolRegistry 类

**文件：** `packages/runtime/src/tool-registry.js`（新建）

**具体改动：**
1. 实现 `ToolRegistry` 类：
   - `constructor(toolConfigs)` — 解析 config 中的 tools 声明
   - `byGroup(...groups)` — 按 group 标签查询工具子集（多组取并集）
   - `byName(...names)` — 按 name 查询
   - `all()` — 返回全量
   - `toSchema(tool)` — 输出给 LLM 的 schema（去掉 handler / group 等内部字段）
2. 支持 group 为数组（一个工具属于多个组）。

**验收标准：**
- `registry.byGroup('coding')` 返回 coding 组的所有工具 schema
- `registry.byGroup('coding', 'research')` 返回两组的并集
- 输出不包含 `handler`、`group` 字段

---

### T07: 在 Runtime 中集成 ToolRegistry

**文件：** `packages/runtime/src/runtime.js`

**具体改动：**
1. `_loadFile()` 中解析 config.tools 后，创建 `this._toolRegistry = new ToolRegistry(config.tools)`。
2. Script API 注入 `toolsByGroup` / `toolsByName` / `allTools`。
3. 在 `_execScript()` 的 scriptAPI 中添加这三个函数。

**验收标准：**
- .board script 中可以调用 `toolsByGroup('coding')` 得到正确的工具子集
- 工具子集赋值给响应式变量后，template 渲染时可以引用

---

## P1 — runtimeMemory

### T08: ContextManager 新增 memory API

**文件：** `packages/runtime/src/context.js`

**具体改动：**
1. 新增 `this._memory = {}` 属性。
2. 实现 `memory(key, value)` — 设置/清除 runtimeMemory。
3. 实现 `getMemory(key?)` — 读取（带 key 返回单值，不带返回全部）。

**验收标准：**
- `ctx.memory('screenshot', data)` → `ctx.getMemory('screenshot')` 返回 data
- `ctx.memory('screenshot', null)` → `ctx.getMemory('screenshot')` 返回 undefined
- `ctx.getMemory()` 返回所有 memory 的浅拷贝

---

### T09: 将 memory / getMemory 注入 Script API

**文件：** `packages/runtime/src/runtime.js`

**具体改动：**
1. 在 `_execScript()` 的 scriptAPI 中注入 `memory` 和 `getMemory`。
2. `getMemory` 同时需要在 template 的 evalExpr 上下文中可用（state 中注入）。

**验收标准：**
- .board script 中可以调用 `memory('key', value)` 和 `getMemory('key')`
- template 中 `{{ getMemory('screenshot') }}` 能正确求值

---

## P2 — 文档与规范更新

### T10: 更新 spec/SPEC.md

**具体改动：**
1. 移除 "最终编译为 `{ system, messages, tools }`" 的描述。
2. 更新 Template 块说明：顶层标签自由定义，不限于 system/messages/user。
3. 更新 Runtime 工作流：移除 process / processUserMessage 的流程图。
4. 更新 Script 块：钩子精简为 mount / update / destroy。
5. 新增 runtimeMemory 和 memory() API 说明。
6. 新增动态工具加载（toolsByGroup / toolSelection.binding）说明。

---

### T11: 更新 spec/DESIGN.md

**具体改动：**
1. 在核心定位部分反映新的 "任意输入 → 任意输出" 设计。
2. 完善动态工具加载的设计描述（已有框架，补充实现细节）。
3. 新增 runtimeMemory 机制完整描述。
4. 更新待解决问题列表（标记已解决的项）。

---

### T12: 更新 README.md

**具体改动：**
1. .board 文件示例更新：展示自由 template 结构。
2. API 部分确认 `board.update()` 的语义描述。
3. 移除对固定输出格式的暗示。

---

### T13: 更新 examples/usage.js

**具体改动：**
1. 展示 `board.update(input)` 传入任意输入的用法。
2. 展示输出结构由 template 决定。
3. 移除对 `{ system, messages, tools }` 的假设。

---

## P2 — Skill 机制增强

### T14: 热更新增强 — 监听目录内所有 .board 文件

**文件：** `packages/runtime/src/runtime.js`

**具体改动：**
1. `_startWatch()` 增强：检测到新 .board 文件时，注册为可用 skill。
2. 维护一个 `.board` 文件注册表（`this._boardFiles`），记录目录内所有已知的 .board 文件。
3. 子组件（include）变化时，重新加载受影响的父组件。

---

### T15: 条件 include 实现

**文件：** `packages/parser/src/template.js`、`packages/runtime/src/renderer.js`

**具体改动：**
1. Parser 支持 `<include src="..." :if="condition" />` 语法。
2. Renderer 在渲染 include 节点时，先检查 `:if` 条件，条件为 false 时跳过。
3. Runtime 负责加载被 include 的子 .board 文件并递归渲染。

---

## P3 — 后续增强

### T16: toolSelection.mode 支持 mcp

**预留设计，暂不实现。** Config 中支持声明 `mode: mcp`，后续对接 MCP 协议。

---

### T17: 跨实例通信 EventBus

**当前预留了 `emit` / `on` 接口，但跨实例通信未实现。** 后续需要一个进程级 EventBus。

---

### T18: AI 生成组件安全沙箱

**Config 预留了 `sandbox: true` 字段。** 后续需要对 AI 运行时生成的 .board 文件做安全限制（如禁止某些 Node.js API）。

---

## 实施顺序总结

```
Phase 1 — P0 基础（Parser + Renderer + Runtime 核心改造）
  T01 → T02 → T03 → T04 → T05
  ↑ parser 先行，renderer/runtime 依赖新 AST 结构

Phase 2 — P1 功能（动态工具 + runtimeMemory）
  T06 → T07（工具线）
  T08 → T09（memory 线）
  两条线可并行

Phase 3 — P2 文档 + Skill
  T10 → T11 → T12 → T13（文档线，可随 Phase 1/2 同步进行）
  T14 → T15（skill 增强，依赖 Phase 1 完成）

Phase 4 — P3 后续
  T16, T17, T18（按需推进）
```

---

## 风险与注意事项

1. **AST 结构变化是全局影响** — T01（parser 改造）会导致 renderer 和 runtime 中所有读取 `ast.template.system` / `ast.template.messages` 的代码失效。建议 T01-T03 作为一个原子批次提交。

2. **测试先行** — T02/T05 的测试更新应该在功能改动之前先写好（作为验收标准），然后让测试驱动实现。

3. **向后兼容不是目标** — 当前 0.1.0 无外部用户，可以放心做 breaking change。但内部的 examples/usage.js 和测试文件需要同步更新。

4. **script 沙箱安全性** — 当前使用 `new AsyncFunction()` 执行 script，没有沙箱隔离。T18 是后续需要关注的安全问题，但不阻塞本次重设计。
