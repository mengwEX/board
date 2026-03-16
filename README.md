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
  <!-- define your output structure here -->
  <!-- use reactive variables from <script> -->
  {{ result }}
</template>

<script>
let result = ''

on('update', (input) => {
  // handle whatever input format you defined
  // update reactive state — template re-renders automatically
  result = process(input)
})

// context routing APIs
// turn(data)        — available this turn only
// history(data)     — enters conversation history
// session(key, val) — persists entire session
// drop(data)        — discard
</script>

<config>
# any config your runtime needs
</config>
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

// cleanup
await board.destroy()
```

## Packages

| Package | Description |
|---------|-------------|
| `@board/core` | SDK — `createBoard`, `board.update` |
| `@promptu/runtime` | Reactive runtime, hot reload, hook system |
| `@promptu/parser` | `.board` file parser |

## Status

🚧 Early development.

## License

MIT
