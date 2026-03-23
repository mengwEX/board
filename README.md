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

// event system (within script)
// emit(event, payload)         — fire a named event
// on('emit:myEvent', handler)  — listen to emitted events
</script>

<config>
model: gpt-4o
tools:
  - name: search
    description: Search the web
    group: default
  - name: code_exec
    description: Execute code
    group: [default, advanced]
</config>
```

Declare tools in `<config>` and access them in scripts via `toolsByGroup()` / `toolsByName()` / `allTools()`. Internal fields (`group`, `handler`) are automatically stripped before the tools are returned, so the result is safe to pass directly to an LLM.

```board
<script>
let activeTools = []

on('update', (input) => {
  // filter tools by the group the user requested
  activeTools = toolsByGroup(input.toolGroup ?? 'default')

  // persist something across turns
  memory('lastToolGroup', input.toolGroup)
})
</script>
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
| `<message role="...">` inside section | Rendered to `[{ role, content }]` array |
| `<user>` / `<assistant>` inside section | Shorthand for `<message role="user/assistant">` |
| `<if :condition="expr">` | Conditionally renders children when `expr` is truthy |
| `<each :items="expr" as="item">` | Iterates over array, renders children for each item |
| Plain text / mixed nodes | Rendered to trimmed string |
| No top-level tags, raw content | Direct value (string or typed) |
| Empty template / no template | `{}` |

`<user>` and `<assistant>` are syntax sugar for `<message role="...">` — they can be mixed freely:

```board
<template>
  <messages>
    {{ history }}
    <user>{{ userInput }}</user>
    <assistant>{{ lastReply }}</assistant>
  </messages>
</template>
```

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

### Conditionals and loops

Use `<if>` and `<each>` inside sections for dynamic content:

```board
<template>
  <system>
    You are {{ role }}.
    <if :condition="debug">
      [DEBUG MODE ON]
    </if>
  </system>

  <messages>
    {{ history }}
    <each :items="examples" as="ex">
      <user>{{ ex.input }}</user>
      <assistant>{{ ex.output }}</assistant>
    </each>
    <user>{{ userInput }}</user>
  </messages>
</template>
```

### File includes

`<include src="..." />` reads and inlines the referenced file at render time. The path is resolved relative to the `.board` file.

```board
<template>
  <system>
    <include src="./prompts/base-instructions.txt" />
    <if :condition="debug">
      [DEBUG MODE ON]
    </if>
  </system>

  <messages>
    {{ history }}
    <include src="./prompts/few-shot-examples.txt" />
    <user>{{ userInput }}</user>
  </messages>
</template>
```

Use `:src="expr"` for dynamic paths evaluated against the current state:

```board
<template>
  <system>
    <include :src="`./prompts/${lang}-instructions.txt`" />
  </system>
</template>
<script>
let lang = 'en'
on('update', (input) => { lang = input.lang ?? 'en' })
</script>
```

When used inside a `<messages>` section, the included content is treated as a message. The default role is `user`; use the `role` attribute to override:

```board
<messages>
  <include src="./prompts/system-note.txt" role="assistant" />
  <message role="user">{{ userInput }}</message>
</messages>
```

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

// trim history to the most recent N entries (low-priority items removed first)
board.trimHistory(20)

// fire a named event from outside (script listens via on('emit:name', fn))
await board.emit('name', payload)

// listen to runtime or emit events from outside
board.on('emit:name', (payload) => { /* ... */ })

// remove a specific listener
board.off('emit:name', handler)

// remove all listeners for an event
board.off('emit:name')

// cleanup
await board.destroy()
```

### Script hooks

Inside a `.board` `<script>`, these lifecycle hooks are available:

| Hook | When it fires |
|------|---------------|
| `on('mount', fn)` | After board loads (and after hot-reload) |
| `on('update', fn)` | Each `board.update(input)` call |
| `on('destroy', fn)` | On `board.destroy()` |
| `on('emit:name', fn)` | When `emit('name', payload)` is called from script |

### Script context APIs

**Context routing**

| API | Description |
|-----|-------------|
| `turn(data, opts?)` | Route data to current turn only (auto-discarded after render) |
| `history(data, opts?)` | Append to conversation history (`opts.role`: `'tool'` default; `opts.priority`: `'high'`/`'normal'`/`'low'` — affects `trimHistory()` eviction order) |
| `session(key, value)` | Store a value for the session lifetime; also accepts `session({ key: value })` for bulk writes |
| `inject(key)` | Read a session-stored value |
| `drop(data)` | Explicitly discard data (no-op, for clarity) |
| `emit(event, payload)` | Fire a named event; listen with `on('emit:event', fn)` |

**Tool registry** (requires `tools:` in `<config>`)

| API | Description |
|-----|-------------|
| `allTools()` | Return all declared tools (internal fields like `group`/`handler` stripped) |
| `toolsByGroup(...groups)` | Return tools belonging to any of the given groups |
| `toolsByName(...names)` | Return tools with the given names |

**Runtime memory** (persists across turns, manually managed)

| API | Description |
|-----|-------------|
| `memory(key, value)` | Set a runtime memory entry; pass `null`/`undefined` to delete the key |
| `getMemory(key?)` | Read a single entry by key, or get a shallow copy of all entries if key is omitted |

## Packages

| Package | Description |
|---------|-------------|
| `@board/core` | Public SDK — `createBoard`, `board.update` |
| `@promptu/runtime` *(internal)* | Reactive runtime, hot reload, hook system |
| `@promptu/parser` *(internal)* | `.board` file parser |

## Debug

Set `BOARD_DEBUG=1` to enable verbose template expression error logging:

```bash
BOARD_DEBUG=1 node your-script.js
```

When enabled, template interpolation errors (e.g. undefined variables in `{{ expr }}`) are printed to stderr instead of silently returning `''`.

## Status

🚧 Early development.

## License

MIT
