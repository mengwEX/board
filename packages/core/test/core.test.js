/**
 * @board/core integration test
 * node test/core.test.js
 */

import { createBoard, Board } from '../src/index.js'
import { writeFile, mkdir } from 'fs/promises'
import { writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'

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

// ─── Test 6: board.emit() triggers on('emit:name') handler in script ────

await test('board.emit() triggers script on(\'emit:name\') handler', async () => {
  const path = await writeTmp('c6.board', `
<template>
  <out>{{ received }}</out>
</template>
<script>
let received = ''
on('emit:ping', (payload) => { received = payload })
</script>
`)
  const board = await createBoard(path, { watch: false })

  await board.emit('ping', 'hello-from-outside')
  const result = await board.update({})
  assert(result.out === 'hello-from-outside', 'emit() should trigger script on(\'emit:name\')')

  await board.destroy()
})

// ─── Test 7: board.on() listens to emit events from script ───────────────

await test('board.on() listens to emit events fired from script', async () => {
  const path = await writeTmp('c7.board', `
<template>
  <out>{{ val }}</out>
</template>
<script>
let val = 0
on('update', () => {
  val++
  emit('tick', val)
})
</script>
`)
  const board = await createBoard(path, { watch: false })

  const ticks = []
  board.on('emit:tick', (payload) => { ticks.push(payload) })

  await board.update({})
  await board.update({})
  assert(ticks.length === 2, 'board.on() should receive both emit:tick events')
  assert(ticks[0] === 1 && ticks[1] === 2, 'payloads should match script emit values')

  await board.destroy()
})

// ─── Test 8: board.off() removes listeners ───────────────────────────────

await test('board.off(event, fn) removes specific listener', async () => {
  const path = await writeTmp('c8.board', `
<template>
  <out>{{ val }}</out>
</template>
<script>
let val = 0
on('update', () => { val++; emit('tick', val) })
</script>
`)
  const board = await createBoard(path, { watch: false })

  const received = []
  const handler = (p) => received.push(p)
  board.on('emit:tick', handler)

  await board.update({})
  assert(received.length === 1, 'handler fires before off()')

  board.off('emit:tick', handler)
  await board.update({})
  assert(received.length === 1, 'handler should not fire after off(fn)')

  await board.destroy()
})

await test('board.off(event) removes all listeners for event', async () => {
  const path = await writeTmp('c9.board', `
<template>
  <out>{{ val }}</out>
</template>
<script>
let val = 0
on('update', () => { val++; emit('tick', val) })
</script>
`)
  const board = await createBoard(path, { watch: false })

  const a = []
  const b = []
  board.on('emit:tick', (p) => a.push(p))
  board.on('emit:tick', (p) => b.push(p))

  await board.update({})
  assert(a.length === 1 && b.length === 1, 'both handlers fire before off()')

  board.off('emit:tick')
  await board.update({})
  assert(a.length === 1 && b.length === 1, 'no handlers fire after off() all')

  await board.destroy()
})

await test('board.load() updates entryPath so hot-reload tracks new file', async () => {
  // board-A in tmpDir, board-B also in tmpDir but loaded via load()
  const pathA = await writeTmp('c10a.board', `
<template>
  <out>board-A</out>
</template>
`)
  const pathB = await writeTmp('c10b.board', `
<template>
  <out>board-B</out>
</template>
`)
  const board = await createBoard(pathA, { watch: false })
  const r1 = await board.update({})
  assert(r1.out === 'board-A', 'should render board A initially')

  await board.load(pathB)
  const r2 = await board.update({})
  assert(r2.out === 'board-B', 'should render board B after load()')

  // _entryPath should now point to pathB (via runtime internals)
  assert(board._runtime._entryPath === pathB, 'entryPath should be updated to pathB')

  await board.destroy()
})

// ─── Test: use after destroy throws ──────────────────────────────────────

await test('board.update() throws after destroy()', async () => {
  const boardPath = join(tmpdir(), `board-destroyed-${Date.now()}.board`)
  writeFileSync(boardPath, `
<template><result>ok</result></template>
<script>
on('update', () => {})
</script>
`)
  const board = await createBoard(boardPath, { watch: false })
  await board.destroy()

  let threw = false
  try {
    await board.update({})
  } catch (e) {
    threw = e.message.includes('destroyed')
  }
  assert(threw, 'update() should throw after destroy()')
})

await test('board.destroy() is idempotent', async () => {
  const boardPath = join(tmpdir(), `board-idempotent-${Date.now()}.board`)
  writeFileSync(boardPath, `<template><r>ok</r></template><script>on('update', () => {})</script>`)
  const board = await createBoard(boardPath, { watch: false })
  await board.destroy()
  // second destroy should not throw
  await board.destroy()
  assert(true, 'double destroy() should not throw')
})

// ─── Test: getContext() includes memory field ────────────────────────────

await test('getContext() includes memory field reflecting runtimeMemory state', async () => {
  const boardPath = await writeTmp('ctx-memory.board', `
<template>
  <out>ok</out>
</template>
<script>
let x = 0
on('update', (input) => {
  x = input.v ?? 0
  memory('key', input.val ?? null)
})
</script>
`)
  const board = await createBoard(boardPath, { watch: false })

  // Before any update — memory should be empty
  const ctx0 = board.getContext()
  assert(typeof ctx0.memory === 'object' && ctx0.memory !== null, 'memory should be an object')
  assert(Object.keys(ctx0.memory).length === 0, 'memory should be empty initially')

  // After setting a memory value
  await board.update({ v: 1, val: 'hello' })
  const ctx1 = board.getContext()
  assert(ctx1.memory.key === 'hello', 'memory.key should be "hello" after update')

  // After clearing memory (passing null)
  await board.update({ v: 2, val: null })
  const ctx2 = board.getContext()
  assert(ctx2.memory.key === undefined, 'memory.key should be removed after null update')

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
