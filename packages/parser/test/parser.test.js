/**
 * parser 基础测试
 * node --experimental-vm-modules test/parser.test.js
 */

import { parse } from '../src/index.js'

const sample = `
<!-- 测试组件 -->

<template>
  <system>
    You are {{ role }}.
    <if :condition="hasContext">
    Context: {{ ctx }}
    </if>
  </system>

  <messages>
    {{ history.last(5) }}
  </messages>

  <user>
    {{ currentInput }}
  </user>
</template>

<script>
import { turn, history } from '@promptu/context'

let role = 'assistant'
let currentInput = ''

on('message', (input) => {
  currentInput = input.content
})

on('tool_response', (result) => {
  turn(result.raw)
  history(result.summary)
})
</script>

<config>
model: gpt-4o
max_tokens: 4000
tools:
  - web_search
</config>
`

const ast = parse(sample, 'test.board')

console.log('=== Parser Test ===\n')

console.log('filename:', ast.filename)
console.log('\n--- template.system ---')
console.log(JSON.stringify(ast.template.system, null, 2))
console.log('\n--- template.messages (null = default history) ---')
console.log(JSON.stringify(ast.template.messages, null, 2))
console.log('\n--- template.user ---')
console.log(JSON.stringify(ast.template.user, null, 2))
console.log('\n--- script (raw) ---')
console.log(ast.script)
console.log('\n--- config ---')
console.log(JSON.stringify(ast.config, null, 2))

console.log('\n✅ Parse OK')
