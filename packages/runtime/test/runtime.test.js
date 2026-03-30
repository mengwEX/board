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
    on(event, fn) {
      if (!runtime._handlers[event]) runtime._handlers[event] = []
      runtime._handlers[event].push(fn)
    },
    off(event, fn) {
      if (!runtime._handlers[event]) return
      if (fn) {
        runtime._handlers[event] = runtime._handlers[event].filter(h => h !== fn)
      } else {
        delete runtime._handlers[event]
      }
    },
    async destroy() { await runtime.stop() },
  }
}

// Shorthand: create an inline board without specifying a filename.
// Uses a counter so parallel tests don't share filenames.
let _inlineBoardCounter = 0
async function createInlineBoard(source) {
  return createTestBoard(`inline-${++_inlineBoardCounter}.board`, source)
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

// ─── Test: <include :src="expr"> dynamic src ─────────────────────────────

await test('<include :src="expr"> resolves dynamic src against current state', async () => {
  const fileA = join(tmpDir, 'dynamic_a.txt')
  const fileB = join(tmpDir, 'dynamic_b.txt')
  await writeFile(fileA, 'FILE A CONTENT')
  await writeFile(fileB, 'FILE B CONTENT')

  const board = await createTestBoard('include_dynamic_src.board', `
<template>
  <system>
    <include :src="currentFile" />
  </system>
</template>
<script>
let currentFile = 'dynamic_a.txt'
on('update', (input) => { currentFile = input.file })
</script>
`)

  const r1 = await board.update({ file: 'dynamic_a.txt' })
  assert(r1.system.includes('FILE A CONTENT'), `should render file A, got: "${r1.system}"`)

  const r2 = await board.update({ file: 'dynamic_b.txt' })
  assert(r2.system.includes('FILE B CONTENT'), `should render file B, got: "${r2.system}"`)

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

// ─── Test: <include> inside messages section renders as user message ─────────

await test('<include src="..."> inside messages section renders as user message', async () => {
  const { writeFile } = await import('fs/promises')
  const { join } = await import('path')

  const partialPath = join(tmpDir, 'system-part.txt')
  await writeFile(partialPath, 'You are a helpful assistant.')

  const board = await createTestBoard('include-in-messages.board', `
<template>
  <messages>
    <include src="system-part.txt" />
    <user>Hello</user>
  </messages>
</template>
`)
  const output = await board.update({})
  assert(Array.isArray(output.messages), 'messages should be array')
  assert(output.messages.length === 2, 'expected 2 messages, got ' + output.messages.length)
  assert(
    output.messages[0].role === 'user' && output.messages[0].content === 'You are a helpful assistant.',
    'unexpected first message: ' + JSON.stringify(output.messages[0])
  )
  assert(
    output.messages[1].role === 'user' && output.messages[1].content === 'Hello',
    'unexpected second message: ' + JSON.stringify(output.messages[1])
  )
  await board.destroy()
})

await test('emit() handler can be async and is awaited', async () => {
  const board = await createTestBoard('emit-async.board', `
<template>
  <result>{{ result }}</result>
</template>
<script>
let result = 'none'

on('update', async () => {
  await emit('fetch', 42)
})

on('emit:fetch', async (val) => {
  // Simulate async work (e.g., fetching data)
  await new Promise(resolve => setTimeout(resolve, 10))
  result = 'async-' + val
})
</script>
`)
  const output = await board.update({})
  assert(output.result === 'async-42', `expected 'async-42', got '${output.result}'`)
  await board.destroy()
})

await test('<each> inside messages section renders items as messages', async () => {
  const board = await createTestBoard('each-messages.board', `
<template>
  <messages>
    <each :items="examples" as="ex">
      <user>{{ ex.input }}</user>
      <assistant>{{ ex.output }}</assistant>
    </each>
    <user>{{ userInput }}</user>
  </messages>
</template>
<script>
let examples = []
let userInput = ''

on('update', (input) => {
  examples = input.examples ?? []
  userInput = input.message ?? ''
})
</script>
`)
  const output = await board.update({
    examples: [
      { input: 'hello', output: 'hi there' },
      { input: 'bye', output: 'goodbye' },
    ],
    message: 'how are you?',
  })
  assert(Array.isArray(output.messages), 'messages should be array')
  assert(output.messages.length === 5, `expected 5 messages, got ${output.messages.length}`)
  assert(output.messages[0].role === 'user' && output.messages[0].content === 'hello', 'first example user msg')
  assert(output.messages[1].role === 'assistant' && output.messages[1].content === 'hi there', 'first example assistant msg')
  assert(output.messages[4].role === 'user' && output.messages[4].content === 'how are you?', 'final user msg')
  await board.destroy()
})

await test('<each> inside messages section uses default "item" alias when :as omitted', async () => {
  const board = await createTestBoard('each-messages-default-as.board', `
<template>
  <messages>
    <each :items="msgs">
      <user>{{ item.text }}</user>
    </each>
  </messages>
</template>
<script>
let msgs = []

on('update', (input) => {
  msgs = input.msgs ?? []
})
</script>
`)
  const output = await board.update({ msgs: [{ text: 'first' }, { text: 'second' }] })
  assert(Array.isArray(output.messages), 'messages should be array')
  assert(output.messages.length === 2, `expected 2 messages, got ${output.messages.length}`)
  assert(output.messages[0].content === 'first', `expected 'first', got '${output.messages[0].content}'`)
  assert(output.messages[1].content === 'second', `expected 'second', got '${output.messages[1].content}'`)
  await board.destroy()
})

// ─── <include> with role attribute inside messages section ─────────────────

await test('<include role="assistant"> inside messages section uses specified role', async () => {
  const partialPath = join(tmpDir, 'role-include.txt')
  await writeFile(partialPath, 'I am the assistant response.')
  const boardSrc = [
    '<template>',
    '  <messages>',
    '    <message role="user">Hello</message>',
    '    <include src="' + partialPath + '" role="assistant" />',
    '  </messages>',
    '</template>',
    '<script>',
    '</script>',
  ].join('\n')
  const board = await createTestBoard('include-role-test.board', boardSrc)
  const output = await board.update({})
  assert(Array.isArray(output.messages), 'messages should be array')
  assert(output.messages.length === 2, 'expected 2 messages, got ' + output.messages.length)
  assert(output.messages[1].role === 'assistant', "expected role 'assistant', got '" + output.messages[1].role + "'")
  assert(output.messages[1].content === 'I am the assistant response.', 'unexpected content: ' + output.messages[1].content)
  await board.destroy()
})

await test('<message :role="expr"> uses dynamic role evaluated from state', async () => {
  const board = await createTestBoard('dynamic-role-msg.board', `
<template>
  <messages>
    <message :role="currentRole">Hello from dynamic role</message>
  </messages>
</template>
<script>
let currentRole = 'user'
on('update', (input) => { currentRole = input.role ?? 'user' })
</script>
`)
  const r1 = await board.update({ role: 'assistant' })
  assert(Array.isArray(r1.messages), 'messages should be array')
  assert(r1.messages.length === 1, 'should have 1 message')
  assert(r1.messages[0].role === 'assistant', "expected 'assistant', got '" + r1.messages[0].role + "'")

  const r2 = await board.update({ role: 'tool' })
  assert(r2.messages[0].role === 'tool', "expected 'tool', got '" + r2.messages[0].role + "'")
  await board.destroy()
})

// ─── Nested <if> and <each> ──────────────────────────────────────────────────

await test('nested <if> inside <if> renders correctly', async () => {
  const board = await createTestBoard('nested-if.board', `
<template>
  <system>
    <if :condition="outer">
      outer-yes
      <if :condition="inner">inner-yes</if>
    </if>
    base
  </system>
</template>
<script>
let outer = false
let inner = false
on('update', (input) => {
  outer = input.outer ?? false
  inner = input.inner ?? false
})
</script>
`)
  const r1 = await board.update({ outer: false, inner: false })
  assert(!r1.system.includes('outer-yes'), 'outer=false: should not render outer content')
  assert(!r1.system.includes('inner-yes'), 'outer=false: should not render inner content')
  assert(r1.system.includes('base'), 'base text should always render')

  const r2 = await board.update({ outer: true, inner: false })
  assert(r2.system.includes('outer-yes'), 'outer=true,inner=false: outer content should render')
  assert(!r2.system.includes('inner-yes'), 'outer=true,inner=false: inner content should not render')

  const r3 = await board.update({ outer: true, inner: true })
  assert(r3.system.includes('outer-yes'), 'outer=true,inner=true: outer content should render')
  assert(r3.system.includes('inner-yes'), 'outer=true,inner=true: inner content should render')
  await board.destroy()
})

await test('nested <each> inside <each> renders correctly', async () => {
  const board = await createTestBoard('nested-each.board', `
<template>
  <output>
    <each :items="matrix" as="row"><each :items="row" as="cell">{{ cell }},</each></each>
  </output>
</template>
<script>
let matrix = []
on('update', (input) => { matrix = input.matrix ?? [] })
</script>
`)
  const r = await board.update({ matrix: [['a', 'b'], ['c', 'd']] })
  assert(r.output.includes('a,'), 'should contain a')
  assert(r.output.includes('b,'), 'should contain b')
  assert(r.output.includes('c,'), 'should contain c')
  assert(r.output.includes('d,'), 'should contain d')
  await board.destroy()
})

// ─── Test: hook error is re-thrown (not silently swallowed) ──────────────────
test('hook error propagates out of board.update()', async () => {
  const board = await createTestBoard('hook-error.board', `
<template>{{ msg }}</template>
<script>
  let msg = 'ok'
  on('update', () => { throw new Error('hook boom') })
</script>
`)
  let threw = false
  try {
    await board.update({})
  } catch (e) {
    threw = true
    assert(e.message === 'hook boom', 'error message should propagate')
  }
  assert(threw, 'board.update() should re-throw hook errors')
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


// ═══════════════════════════════════════════════════════════════════════════
// ToolRegistry — toolsByGroup / toolsByName / allTools
// ═══════════════════════════════════════════════════════════════════════════

test('toolsByGroup returns tools matching a single group', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ tools }}</result>
</template>
<script>
let tools = []
on('update', () => {
  tools = toolsByGroup('coding')
})
</script>
<config>
tools:
  - name: run_code
    description: Execute code
    group: coding
  - name: web_search
    description: Search the web
    group: research
</config>
`)
  const out = await board.update({})
  assert(Array.isArray(out.result), 'result should be array')
  assert(out.result.length === 1, 'should return 1 tool')
  assert(out.result[0].name === 'run_code', 'should return run_code')
  assert(!('group' in out.result[0]), 'group field should be stripped')
  await board.destroy()
})

test('toolsByGroup union across multiple groups', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ tools }}</result>
</template>
<script>
let tools = []
on('update', () => {
  tools = toolsByGroup('coding', 'research')
})
</script>
<config>
tools:
  - name: run_code
    description: Execute code
    group: coding
  - name: web_search
    description: Search the web
    group: research
  - name: send_email
    description: Send an email
    group: comms
</config>
`)
  const out = await board.update({})
  assert(out.result.length === 2, 'should return tools from both groups')
  const names = out.result.map(t => t.name)
  assert(names.includes('run_code'), 'should include run_code')
  assert(names.includes('web_search'), 'should include web_search')
  await board.destroy()
})

test('toolsByGroup: tool with array group membership', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ tools }}</result>
</template>
<script>
let tools = []
on('update', () => {
  tools = toolsByGroup('coding')
})
</script>
<config>
tools:
  - name: multi_tool
    description: Works in coding and research
    group:
      - coding
      - research
</config>
`)
  const out = await board.update({})
  assert(out.result.length === 1, 'should match tool in array group')
  assert(out.result[0].name === 'multi_tool', 'should return multi_tool')
  await board.destroy()
})

test('toolsByName returns specific tools', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ tools }}</result>
</template>
<script>
let tools = []
on('update', () => {
  tools = toolsByName('web_search')
})
</script>
<config>
tools:
  - name: run_code
    description: Execute code
    group: coding
  - name: web_search
    description: Search the web
    group: research
</config>
`)
  const out = await board.update({})
  assert(out.result.length === 1, 'should return 1 tool')
  assert(out.result[0].name === 'web_search', 'should return web_search')
  await board.destroy()
})

test('allTools returns all tools without internal fields', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ tools }}</result>
</template>
<script>
let tools = []
on('update', () => {
  tools = allTools()
})
</script>
<config>
tools:
  - name: run_code
    description: Execute code
    group: coding
  - name: web_search
    description: Search the web
    group: research
</config>
`)
  const out = await board.update({})
  assert(out.result.length === 2, 'should return all 2 tools')
  for (const t of out.result) {
    assert(!('group' in t), 'group field should be stripped from all tools')
  }
  await board.destroy()
})

test('toolsByGroup returns empty array when no config.tools', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ tools }}</result>
</template>
<script>
let tools = []
on('update', () => {
  tools = toolsByGroup('coding')
})
</script>
`)
  const out = await board.update({})
  assert(Array.isArray(out.result), 'should return array')
  assert(out.result.length === 0, 'should return empty array when no tools configured')
  await board.destroy()
})

// ═══════════════════════════════════════════════════════════════════════════
// runtimeMemory — memory() / getMemory()
// ═══════════════════════════════════════════════════════════════════════════

test('memory() sets value, getMemory() reads it', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ val }}</result>
</template>
<script>
let val = ''
on('update', (input) => {
  if (input.set) {
    memory('screenshot', input.set)
  }
  val = getMemory('screenshot') ?? 'none'
})
</script>
`)
  await board.update({ set: 'img_001' })
  const out = await board.update({})
  assert(out.result === 'img_001', 'getMemory should return persisted value')
  await board.destroy()
})

test('memory() with null removes the key', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ val }}</result>
</template>
<script>
let val = ''
on('update', (input) => {
  if (input.set) memory('key', input.set)
  if (input.clear) memory('key', null)
  val = getMemory('key') ?? 'gone'
})
</script>
`)
  await board.update({ set: 'hello' })
  await board.update({ clear: true })
  const out = await board.update({})
  assert(out.result === 'gone', 'getMemory should return undefined after null')
  await board.destroy()
})

test('getMemory() without key returns all memory entries', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ snapshot }}</result>
</template>
<script>
let snapshot = {}
on('update', (input) => {
  if (input.a) memory('a', input.a)
  if (input.b) memory('b', input.b)
  snapshot = getMemory()
})
</script>
`)
  await board.update({ a: 'alpha' })
  const out = await board.update({ b: 'beta' })
  assert(out.result.a === 'alpha', 'should include a')
  assert(out.result.b === 'beta', 'should include b')
  await board.destroy()
})

test('memory persists across multiple update() calls', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ counter }}</result>
</template>
<script>
let counter = 0
on('update', () => {
  const current = getMemory('count') ?? 0
  memory('count', current + 1)
  counter = getMemory('count')
})
</script>
`)
  await board.update({})
  await board.update({})
  const out = await board.update({})
  assert(out.result === 3, 'counter should have incremented 3 times')
  await board.destroy()
})

test('getMemory() works in template expressions', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ getMemory('tag') }}</result>
</template>
<script>
on('update', (input) => {
  if (input.tag) memory('tag', input.tag)
})
</script>
`)
  await board.update({ tag: 'v2' })
  const out = await board.update({})
  assert(out.result === 'v2', 'getMemory should be accessible in template expressions')
  await board.destroy()
})

test('session() bulk-write sets multiple keys at once', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ val1 }}-{{ val2 }}</result>
</template>
<script>
let val1 = ''
let val2 = ''
on('update', () => {
  session({ key1: 'alpha', key2: 'beta' })
  val1 = inject('key1')
  val2 = inject('key2')
})
</script>
`)
  const out = await board.update({})
  assert(out.result === 'alpha-beta', 'bulk session write should set both keys')
  await board.destroy()
})

// ─── Test: conditional include (:if) ────────────────────────────────────

await test('<include :if="cond"> skips load when condition is false', async () => {
  // Write an include file to the tmp dir
  const includeFile = join(tmpDir, 'cond-include.txt')
  await writeFile(includeFile, 'INCLUDED CONTENT')

  const board = await createInlineBoard(`
<template>
  <system><include :if="showExtra" src="./cond-include.txt" /></system>
</template>
<script>
let showExtra = false
on('update', (input) => {
  showExtra = input.show ?? false
})
</script>
`)
  // Condition false → include should be skipped
  const out1 = await board.update({ show: false })
  assert(!out1.system.includes('INCLUDED CONTENT'), ':if=false should skip include')
  assert(out1.system.trim() === '', ':if=false should produce empty output')

  // Condition true → include should be loaded
  const out2 = await board.update({ show: true })
  assert(out2.system.includes('INCLUDED CONTENT'), ':if=true should load include')

  await board.destroy()
})

await test('<include :if="cond"> with static if="true" always includes', async () => {
  const includeFile2 = join(tmpDir, 'always-include.txt')
  await writeFile(includeFile2, 'ALWAYS HERE')

  const board = await createInlineBoard(`
<template>
  <system><include if="true" src="./always-include.txt" /></system>
</template>
<script>
on('update', () => {})
</script>
`)
  const out = await board.update({})
  assert(out.system.includes('ALWAYS HERE'), 'static if="true" should always include')
  await board.destroy()
})

// ─── Test: board.off() external listener removal ─────────────────────────────

await test('board.off(event, fn) removes a specific listener', async () => {
  const board = await createInlineBoard(`
<template>
  <result>{{ count }}</result>
</template>
<script>
let count = 0
on('update', () => { count++ })
</script>
`)

  const calls = []
  const handler = (payload) => calls.push(payload)
  board.on('update', handler)

  await board.update({ x: 1 })
  assert(calls.length === 1, 'handler should be called once before off()')

  board.off('update', handler)
  await board.update({ x: 2 })
  assert(calls.length === 1, 'handler should not be called after off(fn)')

  await board.destroy()
})

await test('board.off(event) removes all listeners for an event', async () => {
  const board = await createInlineBoard(`
<template>
  <result>ok</result>
</template>
<script>
on('update', () => {})
</script>
`)

  let calls = 0
  board.on('update', () => calls++)
  board.on('update', () => calls++)

  await board.update({})
  assert(calls === 2, 'both handlers should fire before off()')

  board.off('update')
  await board.update({})
  assert(calls === 2, 'no handlers should fire after off(event)')

  await board.destroy()
})

await test('<include :src="expr"> inside <each> resolves with loop variable', async () => {
  // Create two include files
  const fileA = join(tmpDir, 'loop-a.txt')
  const fileB = join(tmpDir, 'loop-b.txt')
  const { writeFile: wf } = await import('fs/promises')
  await wf(fileA, 'content-A')
  await wf(fileB, 'content-B')

  const board = await createInlineBoard(`
<template>
  <result>
    <each :items="files" as="f">
      <include :src="f" />
    </each>
  </result>
</template>
<script>
let files = []
on('update', (input) => { files = input.files })
</script>
`)

  const out = await board.update({ files: ['loop-a.txt', 'loop-b.txt'] })
  assert(out.result.includes('content-A'), '<each> include should render content-A')
  assert(out.result.includes('content-B'), '<each> include should render content-B')
  await board.destroy()
})

await test('<include :if="expr"> inside <each> respects loop variable condition', async () => {
  const fileYes = join(tmpDir, 'cond-yes.txt')
  const { writeFile: wf } = await import('fs/promises')
  await wf(fileYes, 'visible')

  const board = await createInlineBoard(`
<template>
  <result>
    <each :items="items" as="it">
      <include :if="it.show" src="cond-yes.txt" />
    </each>
  </result>
</template>
<script>
let items = []
on('update', (input) => { items = input.items })
</script>
`)

  const out = await board.update({ items: [{ show: true }, { show: false }, { show: true }] })
  const matches = (out.result.match(/visible/g) || []).length
  assert(matches === 2, `Expected 2 occurrences of "visible", got ${matches}`)
  await board.destroy()
})

await test('<include :src="expr"> inside <each> in messages section resolves with loop variable', async () => {
  // Regression: renderMessagesNodes was not using _eachResolvedChildren,
  // so dynamic :src inside <each> in a <messages> section would fail.
  const { writeFile: wf } = await import('fs/promises')
  await wf(join(tmpDir, 'msg-a.txt'), 'context-A')
  await wf(join(tmpDir, 'msg-b.txt'), 'context-B')

  const board = await createInlineBoard(`
<template>
  <messages>
    <each :items="docs" as="d">
      <include :src="d.file" :role="d.role" />
    </each>
    <message role="user">query</message>
  </messages>
</template>
<script>
let docs = []
on('update', (input) => { docs = input.docs })
</script>
`)

  const out = await board.update({
    docs: [
      { file: 'msg-a.txt', role: 'system' },
      { file: 'msg-b.txt', role: 'assistant' },
    ],
  })
  assert(Array.isArray(out.messages), 'messages section should return array')
  assert(out.messages.length === 3, `Expected 3 messages, got ${out.messages.length}`)
  assert(out.messages[0].content === 'context-A', `First include should have content-A, got: ${out.messages[0].content}`)
  assert(out.messages[0].role === 'system', `First include should have role=system, got: ${out.messages[0].role}`)
  assert(out.messages[1].content === 'context-B', `Second include should have content-B, got: ${out.messages[1].content}`)
  assert(out.messages[1].role === 'assistant', `Second include should have role=assistant, got: ${out.messages[1].role}`)
  assert(out.messages[2].role === 'user', 'Last message should be role=user')
  await board.destroy()
})

// ═══════════════════════════════════════════════════════════════════════════
// board.load() — runtime board swap
// ═══════════════════════════════════════════════════════════════════════════

await test('board.load() swaps the running board and fires mount hook', async () => {
  const loadTmpDir = join(tmpDir, 'load-test')
  await mkdir(loadTmpDir, { recursive: true })

  const pathA = join(loadTmpDir, 'a.board')
  const pathB = join(loadTmpDir, 'b.board')

  await writeFile(pathA, `
<template>
  <result>{{ label }}</result>
</template>
<script>
let label = 'board-A'
</script>
`)

  await writeFile(pathB, `
<template>
  <result>{{ label }}</result>
</template>
<script>
let label = 'board-B'
on('mount', () => { label = 'board-B-mounted' })
</script>
`)

  const rt = new PromptuRuntime(pathA, { watch: false })
  await rt.start()

  await rt._triggerHook('update', {})
  const out1 = await rt._render()
  assert(out1.result === 'board-A', `Expected board-A, got ${out1.result}`)

  // swap to board B — _loadFile + mount hook (mirrors Board.load())
  await rt._loadFile(pathB)
  await rt._triggerHook('mount')

  await rt._triggerHook('update', {})
  const out2 = await rt._render()
  assert(out2.result === 'board-B-mounted', `Expected board-B-mounted after load(), got ${out2.result}`)

  await rt.stop()
})

// ═══════════════════════════════════════════════════════════════════════════
// board.destroy() idempotency
// ═══════════════════════════════════════════════════════════════════════════

await test('PromptuRuntime.stop() is idempotent (calling twice does not throw)', async () => {
  const board = await createInlineBoard(`
<template><result>ok</result></template>
<script></script>
`)
  // destroy once via the helper (calls rt.stop())
  await board.destroy()
  // calling destroy() again should be safe
  let threw = false
  try {
    await board.destroy()
  } catch (e) {
    threw = true
  }
  assert(!threw, 'destroy() should not throw when called a second time')
})
