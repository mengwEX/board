# Board

> Reactive context engine for AI agents

Board sits between an LLM response and the next LLM request. It runs your `.board` file — a reactive component where you define how inputs are processed and what the output looks like.

**Board does not decide input/output format. You do.**

## How it works

```
any input
    ↓
[ Board Runtime ]
· triggers on() hooks in your .board script
· reactive state updates
· re-renders <template>
    ↓
any output  ← defined by your <template>
```

Your code handles the LLM calls. Board handles everything in between.

## Install

```bash
npm install @board/core
```

## Usage

```js
import { createBoard } from '@board/core'

const board = await createBoard('./main.board')

// pass anything in, get your template output back
const output = await board.update(input)
```

`input` — any structure. Your `.board` script handles it via `on('update', input => { ... })`.

`output` — whatever your `.board` `<template>` renders.

## .board file

```board
<template>
  <!-- Top-level tags become keys in the output object -->
  <system>
    You are {{ role }}. Help the user with {{ task }}.
  </system>

  <messages>
    <!-- message nodes render to [{ role, content }] arrays -->
    {{ history }}
    <message role="user">{{ userInput }}</message>
  </messages>

  <tools>
    <!-- single interpolation preserves original type (array/object) -->
    {{ activeTools }}
  </tools>
</template>

<script>
let role = 'assistant'
let task = 'general tasks'
let userInput = ''
let history = []
let activeTools = []

on('update', (input) => {
  // handle whatever input format you defined
  // update reactive state — template re-renders automatically
  userInput = input.message
  history = input.history ?? []
})

// context routing APIs
// turn(data)        — available this turn only
// history(data)     — enters conversation history
// session(key, val) — persists entire session
// inject(key)       — read session value
// drop(data)        — discard
</script>

<config>
model: gpt-4o
</config>
```

The above produces:

```js
{
  system: "You are assistant. Help the user with general tasks.",
  messages: [
    ...history,
    { role: "user", content: "..." }
  ],
  tools: [/* activeTools array preserved as-is */]
}
```

### Template output rules

| Template pattern | Output |
|---|---|
| Top-level `<tag>...</tag>` | `output.tag = ...` |
| Single `{{ expr }}` → object/array | Value preserved as-is |
| `<message>` nodes inside section | Rendered to `[{ role, content }]` array |
| Plain text / mixed nodes | Rendered to trimmed string |
| No top-level tags, raw content | Direct value (string or typed) |
| Empty template / no template | `{}` |

### Custom section names

Any tag name works — Board imposes no schema:

```board
<template>
  <prompt>{{ systemPrompt }}</prompt>
  <context>{{ retrievedDocs }}</context>
  <functions>{{ toolDefinitions }}</functions>
</template>
```

→ `{ prompt: "...", context: [...], functions: [...] }`

## API

```js
// create
const board = await createBoard('./main.board', { watch: true })

// core: any input → rendered output
const output = await board.update(input)

// switch board at runtime
await board.load('./other.board')

// inspect state (debug)
board.getState()

// inspect context: { history, session, turn }
board.getContext()

// cleanup
await board.destroy()
```

## Packages

| Package | Description |
|---------|-------------|
| `@board/core` | SDK — `createBoard`, `board.update` |
| `@board/runtime` | Reactive runtime, hot reload, hook system |
| `@board/parser` | `.board` file parser |

## Status

🚧 Early development.

## License

MIT
