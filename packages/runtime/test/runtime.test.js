/**
 * Runtime 端到端测试
 * node test/runtime.test.js
 *
 * 所有测试通过 board.update(input) 入口，
 * 验证 template 自由输出结构。
 */

import { PromptuRuntime } from '../src/index.js'
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

// ─── Helper: 创建 board 实例 ─────────────────────────────────────────────

async function createTestBoard(filename, source) {
  const path = join(tmpDir, filename)
  await writeFile(path, source)
  const runtime = new PromptuRuntime(path, { watch: false })
  await runtime.start()

  return {
    async update(input) {
      await runtime._triggerHook('update', input)
      return runtime._render()
    },
    getState() { return runtime.getState() },
    getContext() { return runtime.getContext() },
    trimHistory(max) { runtime._ctx.trimHistory(max) },
    async destroy() { await runtime.stop() },
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════════════════════

// ─── Test 1: 标准 system/messages/user sections ──────────────────────────

await test('standard sections via board.update()', async () => {
  const board = await createTestBoard('t1.board', `
<template>
  <system>
    You are {{ role }}.
    Task: {{ task }}
  </system>
  <user>
    {{ currentInput }}
  </user>
</template>

<script>
let role = 'a helpful assistant'
let task = 'assist the user'
let currentInput = ''

on('update', (input) => {
  currentInput = input.content ?? ''
  task = 'respond to: ' + currentInput.slice(0, 20)
})
</script>
`)

  const result = await board.update({ content: 'hello world' })

  assert(typeof result.system === 'string', 'system should be string')
  assert(result.system.includes('a helpful assistant'), 'system should contain role')
  assert(result.system.includes('respond to: hello world'), 'system should contain updated task')
  assert(result.user === 'hello world', 'user should be currentInput')

  await board.destroy()
})

// ─── Test 2: 自定义 section 名 ──────────────────────────────────────────

await test('custom section names', async () => {
  const board = await createTestBoard('t2.board', `
<template>
  <prompt>
    {{ instruction }}
  </prompt>
  <context>
    {{ contextData }}
  </context>
  <functions>
    {{ toolList }}
  </functions>
</template>

<script>
let instruction = 'You are a coder.'
let contextData = ''
let toolList = []

on('update', (input) => {
  contextData = input.context ?? ''
  toolList = input.tools ?? []
})
</script>
`)

  const result = await board.update({
    context: 'Working on project X',
    tools: [{ name: 'run_code' }, { name: 'read_file' }],
  })

  assert(result.prompt === 'You are a coder.', 'prompt section')
  assert(result.context === 'Working on project X', 'context section')
  assert(Array.isArray(result.functions), 'functions should be array')
  assert(result.functions.length === 2, 'functions should have 2 items')
  assert(result.functions[0].name === 'run_code', 'first function name')

  // 不应有 system/messages/tools 等硬编码字段
  assert(result.system === undefined, 'no hardcoded system field')
  assert(result.messages === undefined, 'no hardcoded messages field')
  assert(result.tools === undefined, 'no hardcoded tools field')

  await board.destroy()
})

// ─── Test 3: 无 section template（rawNodes）──────────────────────────────

await test('raw template (no sections) returns direct value', async () => {
  const board = await createTestBoard('t3.board', `
<template>
  {{ output }}
</template>

<script>
let output = { greeting: 'hello' }

on('update', (input) => {
  output = { greeting: 'hello', name: input.name }
})
</script>
`)

  const result = await board.update({ name: 'Alice' })

  assert(typeof result === 'object', 'result should be object')
  assert(result.greeting === 'hello', 'greeting should be hello')
  assert(result.name === 'Alice', 'name should be Alice')

  await board.destroy()
})

// ─── Test 4: 单 interpolation 保留数组类型 ─────────────────────────────

await test('single interpolation preserves array type', async () => {
  const board = await createTestBoard('t4.board', `
<template>
  <items>
    {{ list }}
  </items>
</template>

<script>
let list = []

on('update', (input) => {
  list = input.data ?? []
})
</script>
`)

  const result = await board.update({ data: [1, 2, 3] })

  assert(Array.isArray(result.items), 'items should be array')
  assert(result.items.length === 3, 'items should have 3 elements')
  assert(result.items[0] === 1, 'first item should be 1')

  await board.destroy()
})

// ─── Test 5: <message> 节点渲染为消息数组 ────────────────────────────────

await test('message nodes render to array', async () => {
  const board = await createTestBoard('t5.board', `
<template>
  <messages>
    <message role="system">You are helpful.</message>
    <message role="user">{{ userMsg }}</message>
  </messages>
</template>

<script>
let userMsg = ''

on('update', (input) => {
  userMsg = input.content ?? ''
})
</script>
`)

  const result = await board.update({ content: 'Hi there' })

  assert(Array.isArray(result.messages), 'messages should be array')
  assert(result.messages.length === 2, 'should have 2 messages')
  assert(result.messages[0].role === 'system', 'first message role')
  assert(result.messages[0].content === 'You are helpful.', 'first message content')
  assert(result.messages[1].role === 'user', 'second message role')
  assert(result.messages[1].content === 'Hi there', 'second message content')

  await board.destroy()
})

// ─── Test 6: on('update') 钩子接收任意输入 ─────────────────────────────

await test('update hook receives arbitrary input', async () => {
  const board = await createTestBoard('t6.board', `
<template>
  <result>
    {{ output }}
  </result>
</template>

<script>
let output = 'initial'

on('update', (input) => {
  if (input.type === 'tool_result') {
    output = 'tool: ' + input.data
  } else if (input.type === 'user_message') {
    output = 'user: ' + input.text
  } else {
    output = 'unknown: ' + JSON.stringify(input)
  }
})
</script>
`)

  const r1 = await board.update({ type: 'tool_result', data: 'success' })
  assert(r1.result === 'tool: success', 'tool result handling')

  const r2 = await board.update({ type: 'user_message', text: 'hello' })
  assert(r2.result === 'user: hello', 'user message handling')

  const r3 = await board.update({ type: 'other', x: 1 })
  assert(r3.result.startsWith('unknown:'), 'unknown input handling')

  await board.destroy()
})

// ─── Test 7: 响应式状态更新 ─────────────────────────────────────────────

await test('reactive state updates across calls', async () => {
  const board = await createTestBoard('t7.board', `
<template>
  <system>
    Count: {{ count }}
  </system>
</template>

<script>
let count = 0

on('update', () => {
  count++
})
</script>
`)

  const r1 = await board.update({})
  assert(r1.system === 'Count: 1', 'count should be 1 after first update')

  const r2 = await board.update({})
  assert(r2.system === 'Count: 2', 'count should be 2 after second update')

  const r3 = await board.update({})
  assert(r3.system === 'Count: 3', 'count should be 3 after third update')

  await board.destroy()
})

// ─── Test 8: context API 在 script 中可用 ────────────────────────────────

await test('context API (history/session) available in script', async () => {
  const board = await createTestBoard('t8.board', `
<template>
  <status>
    {{ status }}
  </status>
</template>

<script>
let status = 'idle'

on('update', (input) => {
  if (input.action === 'save') {
    session('lastSaved', input.value)
    history(input.value, { role: 'user' })
    status = 'saved'
  } else if (input.action === 'check') {
    status = 'session:' + inject('lastSaved')
  }
})
</script>
`)

  await board.update({ action: 'save', value: 'test-data' })
  const r2 = await board.update({ action: 'check' })
  assert(r2.status === 'session:test-data', 'session data should be retrievable')

  const ctx = board.getContext()
  assert(ctx.history.length === 1, 'history should have 1 entry')

  await board.destroy()
})

// ─── Test 9: 无 template 的 board ────────────────────────────────────────

await test('board without template returns empty object', async () => {
  const board = await createTestBoard('t9.board', `
<script>
let x = 1
on('update', () => { x++ })
</script>
`)

  const result = await board.update({})
  assert(typeof result === 'object', 'result should be object')
  assert(Object.keys(result).length === 0, 'result should be empty')

  await board.destroy()
})

// ─── Test 10: <if> 条件渲染在 section 内部工作 ─────────────────────────

await test('conditional rendering inside section', async () => {
  const board = await createTestBoard('t10.board', `
<template>
  <system>
    Base prompt.
    <if :condition="debug">
    DEBUG MODE ON.
    </if>
  </system>
</template>

<script>
let debug = false

on('update', (input) => {
  debug = input.debug ?? false
})
</script>
`)

  const r1 = await board.update({ debug: false })
  assert(!r1.system.includes('DEBUG MODE ON'), 'should not include debug when false')

  const r2 = await board.update({ debug: true })
  assert(r2.system.includes('DEBUG MODE ON'), 'should include debug when true')

  await board.destroy()
})

// ─── Test 11: process/processUserMessage 不再存在 ──────────────────────

await test('process/processUserMessage methods do not exist', async () => {
  const board = await createTestBoard('t11.board', `
<template>
  <output>ok</output>
</template>
`)

  // 验证 PromptuRuntime 上没有这些方法
  const path = join(tmpDir, 't11.board')
  const runtime = new PromptuRuntime(path, { watch: false })
  assert(typeof runtime.process === 'undefined', 'process should not exist')
  assert(typeof runtime.processUserMessage === 'undefined', 'processUserMessage should not exist')
  assert(typeof runtime._executeTool === 'undefined', '_executeTool should not exist')
  assert(typeof runtime._registerToolHandlers === 'undefined', '_registerToolHandlers should not exist')

  await board.destroy()
})

// ─── Test 12: <user> and <assistant> shorthand tags render correctly ─────

await test('<user> and <assistant> shorthand render as message objects', async () => {
  const board = await createTestBoard('t12.board', `
<template>
  <messages>
    {{ history }}
    <user>{{ currentMsg }}</user>
    <assistant>{{ lastReply }}</assistant>
  </messages>
</template>

<script>
let history = []
let currentMsg = ''
let lastReply = ''

on('update', (input) => {
  currentMsg = input.message
  lastReply = input.lastReply ?? ''
  history = input.history ?? []
})
</script>
`)

  const result = await board.update({ message: 'hello', lastReply: 'hi there', history: [] })

  assert(Array.isArray(result.messages), 'messages should be array')
  assert(result.messages.length === 2, 'should have 2 messages')
  assert(result.messages[0].role === 'user', 'first message role: user')
  assert(result.messages[0].content === 'hello', 'first message content: hello')
  assert(result.messages[1].role === 'assistant', 'second message role: assistant')
  assert(result.messages[1].content === 'hi there', 'second message content: hi there')

  await board.destroy()
})

// ─── Test: <include> renders file content ────────────────────────────────

await test('<include src="..."> renders included file content', async () => {
  const { writeFile } = await import('fs/promises')
  const { join } = await import('path')

  // Write the file to be included
  const partialPath = join(tmpDir, 'partial.txt')
  await writeFile(partialPath, 'Hello from partial!')

  const board = await createTestBoard('include_test.board', `
<template>
  <system>
    <include src="partial.txt" />
  </system>
</template>
`)

  const result = await board.update({})
  assert(typeof result.system === 'string', 'system should be a string')
  assert(result.system.includes('Hello from partial!'), `system should contain included content, got: "${result.system}"`)

  await board.destroy()
})

// ─── Test: <include> missing file shows error placeholder ─────────────────

await test('<include src="..."> missing file shows error placeholder', async () => {
  const board = await createTestBoard('include_missing.board', `
<template>
  <system>
    <include src="does_not_exist.txt" />
  </system>
</template>
`)

  const result = await board.update({})
  assert(typeof result.system === 'string', 'system should be a string')
  assert(result.system.includes('[include error:'), `should show error placeholder, got: "${result.system}"`)

  await board.destroy()
})

// ─── Test: <if> inside messages section conditionally renders messages ──────

await test('<if> inside messages section conditionally renders/hides messages', async () => {
  const board = await createTestBoard('if_in_messages.board', `
<template>
  <messages>
    {{ history }}
    <if :condition="showSystem">
      <message role="system">You are {{ role }}.</message>
    </if>
    <message role="user">{{ userInput }}</message>
  </messages>
</template>

<script>
let history = []
let showSystem = false
let role = 'assistant'
let userInput = ''

on('update', (input) => {
  userInput = input.message ?? ''
  showSystem = input.showSystem ?? false
  role = input.role ?? 'assistant'
})
</script>
`)

  // showSystem=false — system message should be absent
  let result = await board.update({ message: 'hello', showSystem: false })
  assert(Array.isArray(result.messages), 'messages should be array')
  assert(result.messages.length === 1, `should have 1 message when showSystem=false, got ${result.messages.length}`)
  assert(result.messages[0].role === 'user', 'only message should be user')

  // showSystem=true — system message should appear
  result = await board.update({ message: 'hello', showSystem: true, role: 'pirate' })
  assert(result.messages.length === 2, `should have 2 messages when showSystem=true, got ${result.messages.length}`)
  assert(result.messages[0].role === 'system', 'first message should be system')
  assert(result.messages[0].content.includes('pirate'), `system content should contain role, got: "${result.messages[0].content}"`)
  assert(result.messages[1].role === 'user', 'second message should be user')

  await board.destroy()
})

await test('multi-variable declaration (let a = 1, b = 2) reactive state', async () => {
  const board = await createTestBoard('multi_decl.board', `
<template>
  <out>{{ a }},{{ b }},{{ c }}</out>
</template>

<script>
let a = 1, b = 2, c = 3

on('update', (input) => {
  if (input.a !== undefined) a = input.a
  if (input.b !== undefined) b = input.b
})
</script>
`)

  // Only update b; a and c should keep their initial values
  let result = await board.update({ b: 99 })
  assert(result.out === '1,99,3', `expected '1,99,3', got '${result.out}'`)

  // Only update a; b should retain previous value, c unchanged
  result = await board.update({ a: 50 })
  assert(result.out === '50,99,3', `expected '50,99,3', got '${result.out}'`)

  // State should contain all three variables
  const state = board.getState()
  assert(state.a === 50, `state.a should be 50, got ${state.a}`)
  assert(state.b === 99, `state.b should be 99, got ${state.b}`)
  assert(state.c === 3, `state.c should be 3, got ${state.c}`)

  await board.destroy()
})

// ─── Test: <include> nested inside <if> ──────────────────────────────────

await test('<include> inside <if> resolves when condition is true', async () => {
  const partialPath = join(tmpDir, 'nested_partial.txt')
  await writeFile(partialPath, 'NESTED OK')

  const board = await createTestBoard('include_if_test.board', `
<template>
  <system>
    <if :condition="show">
      <include src="nested_partial.txt" />
    </if>
  </system>
</template>
<script>
let show = false
on('update', (input) => { show = input.show })
</script>
`)

  await board.update({ show: false })
  const r1 = await board.update({ show: false })
  assert(!r1.system.includes('NESTED OK'), 'should not include when condition false')

  const r2 = await board.update({ show: true })
  assert(r2.system.includes('NESTED OK'), `should include when condition true, got: "${r2.system}"`)

  await board.destroy()
})

// ─── Test: trimHistory respects priority ─────────────────────────────────

await test('trimHistory removes low-priority items first', async () => {
  const board = await createTestBoard('trim_history.board', `
<template>{{ out }}</template>
<script>
let out = ''
on('update', (input) => {
  history(input.msg, { priority: input.priority ?? 'normal' })
  out = 'ok'
})
</script>
`)

  await board.update({ msg: 'low-1', priority: 'low' })
  await board.update({ msg: 'normal-1', priority: 'normal' })
  await board.update({ msg: 'high-1', priority: 'high' })

  const ctx1 = board.getContext()
  assert(ctx1.history.length === 3, `should have 3 history items, got ${ctx1.history.length}`)

  board.trimHistory(2)
  const ctx2 = board.getContext()
  assert(ctx2.history.length === 2, `should have 2 after trim, got ${ctx2.history.length}`)
  assert(
    ctx2.history.every(h => h.content !== 'low-1'),
    'low-priority item should be removed first'
  )

  await board.destroy()
})

// ─── emit / on('emit:xxx') event system ─────────────────────────────────────

await test('emit() fires on(\'emit:xxx\') handler', async () => {
  const board = await createTestBoard('emit-basic.board', `
<template>
  <result>{{ result }}</result>
</template>
<script>
let result = 'none'

on('update', () => {
  emit('ping', { value: 42 })
})

on('emit:ping', (payload) => {
  result = 'got-' + payload.value
})
</script>
`)
  const output = await board.update({})
  assert(output.result === 'got-42', `expected 'got-42', got '${output.result}'`)
  await board.destroy()
})

await test('emit() without listener is a no-op (does not throw)', async () => {
  const board = await createTestBoard('emit-noop.board', `
<template>
  <result>{{ result }}</result>
</template>
<script>
let result = 'ok'

on('update', () => {
  emit('silent', { data: 1 })
})
</script>
`)
  let threw = false
  try {
    await board.update({})
  } catch {
    threw = true
  }
  assert(!threw, 'emit with no listener should not throw')
  await board.destroy()
})

await test('emit() can be called multiple times; all listeners fire', async () => {
  const board = await createTestBoard('emit-multi.board', `
<template>
  <log>{{ log }}</log>
</template>
<script>
let log = []

on('update', (input) => {
  emit('step', 'a')
  emit('step', 'b')
  emit('step', 'c')
})

on('emit:step', (val) => {
  log = [...log, val]
})
</script>
`)
  const output = await board.update({})
  assert(
    JSON.stringify(output.log) === JSON.stringify(['a', 'b', 'c']),
    `expected ['a','b','c'], got ${JSON.stringify(output.log)}`
  )
  await board.destroy()
})

// ═══════════════════════════════════════════════════════════════════════════
// Results
// ═══════════════════════════════════════════════════════════════════════════

console.log(`\n${'='.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n❌ Some tests failed')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed')
}

