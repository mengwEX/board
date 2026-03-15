# Promptu Language Specification

> Version: 0.1.0-draft

## Overview

Promptu is a single-file component language for AI agent request orchestration. Each `.ptu` file defines a **Promptu Component** — a composable, reactive unit that controls the complete lifecycle of a single LLM request.

---

## 1. File Structure

A `.ptu` file consists of three top-level blocks:

```ptu
<template>
  <!-- Prompt content, supports variable interpolation and component includes -->
</template>

<script>
  // JavaScript — business logic, state, lifecycle hooks
</script>

<config>
  # YAML — model settings, routing, metadata
</config>
```

All three blocks are optional, but a file with only `<template>` is valid.

---

## 2. Template Block

### 2.1 Variable Interpolation

```ptu
<template>
  You are {{ role }}.
  Current task: {{ task }}
</template>
```

- `{{ expr }}` — evaluates a JavaScript expression from script scope
- Reactive: when the variable changes in `<script>`, the template updates automatically

### 2.2 Component Include

```ptu
<template>
  <include src="./tool-summary.ptu" :data="activeTools" />
</template>
```

- `src` — relative path to child component
- `:data` — prop binding (`:` prefix means JS expression, not string literal)
- The child component's rendered output is inlined at this position

### 2.3 Conditional Rendering

```ptu
<template>
  <if :condition="hasHistory">
    Previous context: {{ history_summary }}
  </if>
</template>
```

### 2.4 Loop Rendering

```ptu
<template>
  <each :items="toolResults" :as="result">
    - Tool: {{ result.name }} → {{ result.output }}
  </each>
</template>
```

---

## 3. Script Block

The script block is JavaScript (ESM). It has access to Promptu built-ins via `@promptu/*` imports.

### 3.1 Context Lifecycle API

```js
import { turn, history, session, drop, inject as ctxInject } from '@promptu/context'

turn(data)      // Route data to current turn only — dropped next round
history(data)   // Route data into conversation history (may be compressed)
session(data)   // Persist data for entire session lifetime
drop(data)      // Discard entirely — never sent to LLM or stored
ctxInject(data) // Inject into prompt context but not into history
```

### 3.2 Component API

```js
// Receive data from parent component or session
inject('user')          // pulls 'user' from parent or session context
inject('activeTools')   // prop injected by parent via :data binding

// Expose data to parent component or sibling via event
emit('task_result', payload)

// Declare reactive state (auto-updates template)
let role = 'assistant'   // plain let — reactive by default in script scope
let task = ''
```

### 3.3 Lifecycle Hooks

```js
// Called when a user message arrives
on('message', (input) => { })

// Called when a tool returns a result
on('tool_response', (result) => { })

// Called when LLM responds (non-tool)
on('llm_response', (response) => { })

// Called when this component is mounted/activated
on('mount', () => { })

// Called when session ends
on('destroy', () => { })
```

### 3.4 Hot-loadable Imports

```js
// Static import — resolved at parse time
import ToolSummary from './tool-summary.ptu'

// Dynamic import — resolved at runtime, supports hot reload
const ToolSummary = await use('./tool-summary.ptu')

// Load and register a new component at runtime (AI can call this)
await register('./new-tool.ptu', { as: 'NewTool' })
```

---

## 4. Config Block

YAML format. All fields optional.

```yaml
# Model configuration
model: gpt-4o           # LLM model identifier
max_tokens: 2000
temperature: 0.7

# Routing — what happens after this component completes
next: ./followup.ptu    # default next component
on_error: ./fallback.ptu

# Component metadata
name: ChatHandler
version: 1.0.0
```

---

## 5. Component Composition

### 5.1 Parent → Child (Props)

```ptu
<!-- parent.ptu -->
<template>
  <include src="./child.ptu" :data="myData" :user="user" />
</template>
```

```ptu
<!-- child.ptu -->
<script>
inject('data')   // receives myData from parent
inject('user')   // receives user from parent
</script>
```

### 5.2 Child → Parent (Events)

```ptu
<!-- child.ptu -->
<script>
on('tool_response', (result) => {
  emit('done', result.summary)
})
</script>
```

```ptu
<!-- parent.ptu -->
<script>
import Child from './child.ptu'

Child.on('done', (summary) => {
  task = summary   // reactive update
})
</script>
```

### 5.3 Session-level Shared State

```js
import { session } from '@promptu/context'

// Write to session
session.set('user_profile', profile)

// Read from session (any component)
const profile = session.get('user_profile')
```

---

## 6. Context Routing — Detailed

When a tool returns data, the AI (via script logic) decides exactly where each piece goes:

```js
on('tool_response', (result) => {
  // result.user_id  → keep for whole session
  session(result.user_id)

  // result.raw_data → only needed this turn
  turn(result.raw_data)

  // result.summary  → useful for future context
  history(result.summary)

  // result.debug    → never needed
  drop(result.debug)

  // result.auth_token → inject into prompt but never store
  inject(result.auth_token)
})
```

This is the core differentiator: **the AI controls exactly what enters the context window, what persists, and what is discarded.**

---

## 7. Hot Reload

The Promptu runtime supports hot reload without restart:

- Changing a `.ptu` file triggers re-parse of that component only
- Active sessions adopt the new component definition on next invocation
- Runtime-registered components (via `register()`) are immediately available

---

## 8. Reserved Keywords

| Keyword | Scope | Description |
|---------|-------|-------------|
| `inject` | script | Receive props/session values |
| `emit` | script | Send events to parent |
| `on` | script | Register lifecycle/event handler |
| `use` | script | Dynamic component import |
| `register` | script | Runtime component registration |
| `turn` | script | Route to current turn |
| `history` | script | Route to conversation history |
| `session` | script | Route to session storage |
| `drop` | script | Discard data |

---

## 9. Open Questions (RFC)

- [ ] How are components versioned when hot-reloaded mid-session?
- [ ] Should `<template>` support multi-language (system/user/assistant roles)?
- [ ] History compression strategy — who decides when to summarize?
- [ ] Should `<config>` support dynamic values (JS expressions)?
- [ ] Security model for AI-created components at runtime
