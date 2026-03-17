/**
 * @board/core integration test
 * node test/core.test.js
 */

import { createBoard, Board } from '../src/index.js'
import { writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir = join(__dirname, 'tmp')

await mkdir(tmpDir, { recursive: true })

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    passed++
  } else {
    failed++
    console.error(`  ❌ FAIL: ${msg}`)
  }
}

async function test(name, fn) {
  console.log(`\n--- ${name} ---`)
  try {
    await fn()
    console.log(`  ✅ passed`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${e.message}`)
    console.error(`  ${e.stack?.split('\n').slice(1, 3).join('\n  ')}`)
  }
}

async function writeTmp(filename, content) {
  const path = join(tmpDir, filename)
  await writeFile(path, content)
  return path
}

// ─── Test 1: createBoard 返回 Board 实例 ────────────────────────────────

await test('createBoard returns Board instance', async () => {
  const path = await writeTmp('c1.board', `
<template>
  <output>{{ value }}</output>
</template>
<script>
let value = 'hello'
</script>
`)
  const board = await createBoard(path, { watch: false })

  assert(board instanceof Board, 'should be Board instance')
  assert(typeof board.update === 'function', 'should have update()')
  assert(typeof board.load === 'function', 'should have load()')
  assert(typeof board.getState === 'function', 'should have getState()')
  assert(typeof board.getContext === 'function', 'should have getContext()')
  assert(typeof board.destroy === 'function', 'should have destroy()')

  await board.destroy()
})

// ─── Test 2: board.update() 端到端 ─────────────────────────────────────

await test('board.update() end-to-end', async () => {
  const path = await writeTmp('c2.board', `
<template>
  <system>You are {{ role }}.</system>
  <messages>
    <message role="user">{{ msg }}</message>
  </messages>
</template>
<script>
let role = 'an AI assistant'
let msg = ''

on('update', (input) => {
  msg = input.text ?? ''
})
</script>
`)
  const board = await createBoard(path, { watch: false })
  const result = await board.update({ text: 'Hello!' })

  assert(result.system === 'You are an AI assistant.', 'system section')
  assert(Array.isArray(result.messages), 'messages should be array')
  assert(result.messages[0].role === 'user', 'message role')
  assert(result.messages[0].content === 'Hello!', 'message content')

  await board.destroy()
})

// ─── Test 3: turn data flushes after each update ────────────────────────

await test('turn data flushes after each update', async () => {
  const path = await writeTmp('c3.board', `
<template>
  <out>{{ val }}</out>
</template>
<script>
let val = ''

on('update', (input) => {
  turn(input.data)
  val = input.data
})
</script>
`)
  const board = await createBoard(path, { watch: false })

  await board.update({ data: 'first' })
  const ctx1 = board.getContext()
  // After first update, turn should be flushed
  assert(ctx1.turn.length === 0, 'turn data should be flushed after update')

  await board.update({ data: 'second' })
  const ctx2 = board.getContext()
  assert(ctx2.turn.length === 0, 'turn data should be flushed after second update')

  await board.destroy()
})

// ─── Test 4: board.load() switches board at runtime ─────────────────────

await test('board.load() switches board file', async () => {
  const path1 = await writeTmp('c4a.board', `
<template>
  <out>board-A</out>
</template>
`)
  const path2 = await writeTmp('c4b.board', `
<template>
  <out>board-B</out>
</template>
`)

  const board = await createBoard(path1, { watch: false })
  const r1 = await board.update({})
  assert(r1.out === 'board-A', 'should render board A')

  await board.load(path2)
  const r2 = await board.update({})
  assert(r2.out === 'board-B', 'should render board B after load()')

  await board.destroy()
})

// ─── Test 5: getState() reflects current reactive state ─────────────────

await test('getState() reflects reactive state', async () => {
  const path = await writeTmp('c5.board', `
<template>
  <out>{{ count }}</out>
</template>
<script>
let count = 0
on('update', () => { count++ })
</script>
`)
  const board = await createBoard(path, { watch: false })

  await board.update({})
  assert(board.getState().count === 1, 'count should be 1')

  await board.update({})
  assert(board.getState().count === 2, 'count should be 2')

  await board.destroy()
})

// ─── Results ─────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n❌ Some tests failed')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed')
}
