/**
 * Runtime 端到端测试
 * node test/runtime.test.js
 */

import { PromptuRuntime } from '../src/index.js'
import { writeFile, mkdir } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const tmpDir = join(__dirname, 'tmp')

await mkdir(tmpDir, { recursive: true })

// ─── 测试用 .ptu 文件 ───────────────────────────────────────────────────────

const testPtu = `
<template>
  <system>
    You are {{ role }}.
    Task: {{ task }}
  </system>

  <messages>
    {{ history.last(5) }}
  </messages>

  <user>
    {{ currentInput }}
  </user>
</template>

<script>
let role = 'a helpful assistant'
let task = 'assist the user'
let currentInput = ''

on('mount', () => {
  console.log('[test.ptu] mounted, role =', role)
})

on('message', (input) => {
  currentInput = input.content
  task = 'respond to: ' + input.content.slice(0, 20)
})

on('tool_response', (result) => {
  // 精细分流
  turn(result.raw ?? result)
  history('Tool result: ' + JSON.stringify(result.result ?? result), { priority: 'low' })
})

on('llm_response', (response) => {
  history(response.content, { role: 'assistant' })
})

// 声明一个工具 handler
async function searchHandler(args) {
  return { query: args.query, results: ['result1', 'result2'] }
}
</script>

<config>
model: gpt-4o
max_tokens: 2000
tools:
  - name: web_search
    description: 搜索网络
    handler: searchHandler
    parameters:
      query:
        type: string
</config>
`

const ptuPath = join(tmpDir, 'test.ptu')
await writeFile(ptuPath, testPtu)

// ─── 运行测试 ──────────────────────────────────────────────────────────────

console.log('=== Promptu Runtime E2E Test ===\n')

const runtime = new PromptuRuntime(ptuPath, { watch: false })
await runtime.start()
console.log('✅ Runtime started\n')

// 1. 用户发消息
console.log('--- 1. processUserMessage ---')
const req1 = await runtime.processUserMessage('你好，帮我搜索一下 AI 框架')
console.log('system:', req1.system)
console.log('messages count:', req1.messages.length)
console.log('tools count:', req1.tools.length)
console.log()

// 2. 模拟 LLM 返回 tool_call
console.log('--- 2. process tool_call ---')
const req2 = await runtime.process({
  tool_calls: [{
    name: 'web_search',
    arguments: { query: 'AI 框架 2024' }
  }]
})
console.log('system:', req2.system)
console.log('messages:', JSON.stringify(req2.messages, null, 2))
console.log()

// 3. 模拟 LLM 文本回复
console.log('--- 3. process text response ---')
const req3 = await runtime.process({
  content: '根据搜索结果，以下是主流 AI 框架...',
  tool_calls: []
})
console.log('messages count:', req3.messages.length)
console.log('history count:', runtime.getContext().history.length)
console.log()

// 4. 验证 context 分流
console.log('--- 4. context check ---')
const ctx = runtime.getContext()
console.log('turn data (应已清空):', ctx.turn)
console.log('history items:', ctx.history.length)
console.log('session:', ctx.session)

console.log('\n✅ All tests passed')
