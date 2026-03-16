# Board

> Reactive context engine for AI agents

Board lets AI control the full LLM request lifecycle. Instead of hardcoded prompt logic, AI reads and writes `.board` files — reactive components that define how context is assembled, how tool results are routed, and what goes into the next LLM request.

## How it works

```
LLM response (text / tool_calls)
        ↓
   [ Board Runtime ]
   · executes tools
   · triggers .board script hooks
   · reactive state update
   · re-renders template
        ↓
{ system, messages, tools }  ← next LLM request
```

Board only handles the middle part. Your code calls the LLM. Board handles everything in between.

## Install

```bash
npm install @board/core
```

## Usage

```js
import { createBoard } from '@board/core'

const board = await createBoard('./main.board')

// user message in → request body out
let request = await board.update({ role: 'user', content: 'Hello' })

// your code calls the LLM
while (true) {
  const response = await yourLLM(request)

  // LLM response in → next request body out
  request = await board.update(response)

  if (!response.tool_calls?.length) {
    console.log(response.content)
    break
  }
}
```

## .board file

A `.board` file is a reactive component with three blocks:

```board
<template>
  <system>
    You are {{ role }}.
    Task: {{ task }}
  </system>

  <messages>
    {{ history.last(10) }}
  </messages>

  <user>
    {{ currentInput }}
  </user>
</template>

<script>
let role = 'a helpful assistant'
let task = ''
let currentInput = ''

on('message', (input) => {
  currentInput = input.content
  task = 'respond to: ' + input.content
})

on('tool_response', (result) => {
  turn(result.raw)          // this turn only
  history(result.summary)   // enters history
  session(result.userId)    // persists entire session
  drop(result.debug)        // discarded
})

on('llm_response', (response) => {
  history(response.content, { role: 'assistant' })
})

async function searchHandler({ query }) {
  return { results: ['...'] }
}
</script>

<config>
model: gpt-4o
max_tokens: 2000
tools:
  - name: web_search
    description: Search the web
    handler: searchHandler
    parameters:
      query:
        type: string
</config>
```

### Context routing

Control exactly where each piece of data lives:

| API | Lifetime |
|-----|----------|
| `turn(data)` | This turn only — dropped next round |
| `history(data)` | Enters conversation history |
| `session(key, value)` | Persists entire session |
| `drop(data)` | Discarded entirely |

## API

```js
// Create a board instance
const board = await createBoard('./main.board', { watch: true })

// Process any LLM message — returns next request body
const request = await board.update(message)

// Switch to a different .board file at runtime
await board.load('./other.board')

// Debug
board.getState()    // reactive state
board.getContext()  // history, session, turn data

// Cleanup
await board.destroy()
```

## Packages

| Package | Description |
|---------|-------------|
| `@board/core` | SDK — `createBoard`, `board.update` |
| `@promptu/runtime` | Runtime engine, hot reload, tool execution |
| `@promptu/parser` | `.board` file parser |

## Status

🚧 Early development. API may change.

## License

MIT
