# Promptu

> A reactive, composable language for AI agent request orchestration.

**Promptu** (`.ptu`) is a new programming language designed for the AI era — inspired by Vue's component model, built for LLM request lifecycle control.

## The Problem

Current agent frameworks (LangChain, AutoGen, etc.) give AI control over *what to do*, but not *how the request itself is constructed*. The context window contents, tool result routing, and next-turn composition are all decided by the framework — not the AI.

Skill mechanisms improved things: AI can now create its own tools. But AI still can't control *what goes into the next request*.

**Promptu gives AI full control over the single-request lifecycle.**

## Core Concepts

### Single File Component (`.ptu`)

Every `.ptu` file is a **Promptu Component** — a self-contained unit that defines:

- **`<template>`** — The prompt content sent to the LLM (reactive, variable-interpolated)
- **`<script>`** — Business logic in JavaScript (handles tool responses, state, routing)
- **`<config>`** — Model settings, routing, metadata

### Reactive Bindings

Variables declared in `<script>` automatically update the `<template>` — no manual re-rendering.

### Context Lifecycle Control

Tool results can be explicitly routed:

```js
turn(data)     // this turn only — dropped next round
history(data)  // enters conversation history
session(data)  // persists entire session
drop(data)     // discarded entirely
inject(data)   // available to LLM but not in history
```

### Component Composition

Components can be nested, emit events, and inject shared state — just like Vue.

## Example

```ptu
<!-- assistant.ptu -->
<template>
  You are {{ role }}.

  User profile: {{ user.name }}, preferences: {{ user.prefs }}

  <include src="./tool-context.ptu" :data="activeTools" />

  Current task: {{ task }}
</template>

<script>
import { session, turn, history, drop } from '@promptu/context'
import ToolContext from './tool-context.ptu'

inject('user')        // persistent across session
inject('activeTools') // provided by parent component

emit('task_result')

on('tool_response', (result) => {
  turn(result.raw)           // single-turn only
  history(result.summary)    // compressed into history
  session(result.user_id)    // persists in session
  drop(result.debug_info)    // never sent anywhere

  task = result.next_task    // reactive: template updates automatically
  emit('task_result', task)
})

on('message', (input) => {
  role = determineRole(input)  // reactive update
})
</script>

<config>
model: gpt-4o
max_tokens: 2000
next: ./followup.ptu
</config>
```

## Architecture

```
User Input / LLM Response / Tool Call
           ↓
    [ Promptu Runtime ]
    ┌─────────────────────────────────┐
    │  Component Tree                 │
    │  ┌──────────────────────────┐   │
    │  │ root.ptu                 │   │
    │  │  ├─ chat.ptu             │   │
    │  │  │   └─ tool-ctx.ptu     │   │
    │  │  └─ executor.ptu         │   │
    │  └──────────────────────────┘   │
    │                                 │
    │  Context Router                 │
    │  @turn / @history / @session    │
    │  @drop / @inject                │
    │                                 │
    │  Hot Reload — no recompile      │
    └─────────────────────────────────┘
           ↓
    Assembled prompt + messages
           ↓
         LLM API
```

## Project Structure

```
promptu/
├── packages/
│   ├── parser/     # .ptu file parser
│   ├── core/       # reactive engine, context router
│   └── runtime/    # Node.js runtime, hot reload, LLM adapter
├── examples/       # example .ptu agents
├── spec/           # language specification
└── docs/           # documentation
```

## Status

🚧 Early design phase. Language spec in progress.

## License

MIT
