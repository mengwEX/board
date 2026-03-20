/**
 * parser 测试
 * node test/parser.test.js
 */

import { parse } from '../src/index.js'

let passed = 0
let failed = 0

function assert(condition, msg) {
  if (condition) {
    passed++
  } else {
    failed++
    console.error(`  ❌ ${msg}`)
  }
}

function test(name, fn) {
  console.log(`\n--- ${name} ---`)
  try {
    fn()
    console.log(`  ✅ passed`)
  } catch (e) {
    failed++
    console.error(`  ❌ ${e.message}`)
  }
}

// ─── Test 1: 标准标签解析为 sections ──────────────────────────────────────

test('standard tags → sections structure', () => {
  const source = `
<template>
  <system>
    You are {{ role }}.
    <if :condition="hasContext">
    Context: {{ ctx }}
    </if>
  </system>

  <messages>
    {{ history }}
  </messages>

  <user>
    {{ currentInput }}
  </user>
</template>

<script>
let role = 'assistant'
let currentInput = ''
</script>

<config>
model: gpt-4o
</config>
`
  const ast = parse(source, 'test.board')

  assert(ast.filename === 'test.board', 'filename should be test.board')
  assert(ast.template !== null, 'template should not be null')
  assert(Array.isArray(ast.template.sections), 'template.sections should be array')
  assert(ast.template.sections.length === 3, 'should have 3 sections')

  const names = ast.template.sections.map(s => s.name)
  assert(names[0] === 'system', 'first section should be system')
  assert(names[1] === 'messages', 'second section should be messages')
  assert(names[2] === 'user', 'third section should be user')

  // system section should contain text, interpolation, and if nodes
  const systemNodes = ast.template.sections[0].nodes
  assert(systemNodes.length > 0, 'system should have nodes')
  assert(systemNodes.some(n => n.type === 'interpolation' && n.expr === 'role'),
    'system should contain {{ role }} interpolation')
  assert(systemNodes.some(n => n.type === 'if'),
    'system should contain <if> node')

  // script and config
  assert(typeof ast.script === 'string', 'script should be string')
  assert(ast.config.model === 'gpt-4o', 'config.model should be gpt-4o')
})

// ─── Test 2: 自定义标签 ─────────────────────────────────────────────────

test('custom tags as sections', () => {
  const source = `
<template>
  <prompt>
    You are a coding assistant.
  </prompt>
  <context>
    {{ contextData }}
  </context>
  <tools>
    {{ activeTools }}
  </tools>
</template>
`
  const ast = parse(source, 'custom.board')

  assert(ast.template.sections.length === 3, 'should have 3 sections')
  const names = ast.template.sections.map(s => s.name)
  assert(names[0] === 'prompt', 'first section: prompt')
  assert(names[1] === 'context', 'second section: context')
  assert(names[2] === 'tools', 'third section: tools')

  // tools section should have interpolation node
  const toolsNodes = ast.template.sections[2].nodes
  assert(toolsNodes.length === 1, 'tools section should have 1 node')
  assert(toolsNodes[0].type === 'interpolation', 'tools node should be interpolation')
  assert(toolsNodes[0].expr === 'activeTools', 'tools expr should be activeTools')
})

// ─── Test 3: 无标签 template（rawNodes）───────────────────────────────────

test('no-section template → rawNodes', () => {
  const source = `
<template>
  {{ result }}
</template>
`
  const ast = parse(source, 'raw.board')

  assert(ast.template.sections.length === 0, 'should have 0 sections')
  assert(Array.isArray(ast.template.rawNodes), 'should have rawNodes array')
  assert(ast.template.rawNodes.length === 1, 'should have 1 raw node')
  assert(ast.template.rawNodes[0].type === 'interpolation', 'raw node should be interpolation')
  assert(ast.template.rawNodes[0].expr === 'result', 'raw node expr should be result')
})

// ─── Test 4: 混合标签（标准 + 自定义）─────────────────────────────────────

test('mixed standard and custom tags', () => {
  const source = `
<template>
  <system>
    You are {{ role }}.
  </system>
  <functions>
    {{ toolList }}
  </functions>
</template>
`
  const ast = parse(source, 'mixed.board')

  assert(ast.template.sections.length === 2, 'should have 2 sections')
  assert(ast.template.sections[0].name === 'system', 'first: system')
  assert(ast.template.sections[1].name === 'functions', 'second: functions')
})

// ─── Test 5: message 节点在 section 内部 ────────────────────────────────

test('message nodes inside section', () => {
  const source = `
<template>
  <messages>
    <message role="user">hello</message>
    <message role="assistant">hi there</message>
  </messages>
</template>
`
  const ast = parse(source, 'msg.board')

  assert(ast.template.sections.length === 1, 'should have 1 section')
  assert(ast.template.sections[0].name === 'messages', 'section: messages')

  const nodes = ast.template.sections[0].nodes
  const msgNodes = nodes.filter(n => n.type === 'message')
  assert(msgNodes.length === 2, 'should have 2 message nodes')
  assert(msgNodes[0].role.value === 'user', 'first message role: user')
  assert(msgNodes[1].role.value === 'assistant', 'second message role: assistant')
})

// ─── Test 6: 空 template ─────────────────────────────────────────────────

test('empty template', () => {
  const source = `
<template>
</template>
`
  const ast = parse(source, 'empty.board')

  assert(ast.template.sections.length === 0, 'should have 0 sections')
  assert(Array.isArray(ast.template.rawNodes), 'should have rawNodes')
  assert(ast.template.rawNodes.length === 0, 'rawNodes should be empty')
})

// ─── Test 7: 单 section template ─────────────────────────────────────────

test('single section template', () => {
  const source = `
<template>
  <output>
    Result: {{ data }}
  </output>
</template>
`
  const ast = parse(source, 'single.board')

  assert(ast.template.sections.length === 1, 'should have 1 section')
  assert(ast.template.sections[0].name === 'output', 'section: output')
  assert(ast.template.sections[0].nodes.some(n => n.type === 'interpolation'),
    'should contain interpolation')
})

// ─── Test 8: <each> 和 <if> 在 section 内部正常工作 ──────────────────────

test('each and if inside section', () => {
  const source = `
<template>
  <system>
    <each :items="items" :as="item">
      - {{ item }}
    </each>
    <if :condition="verbose">
      Debug mode on.
    </if>
  </system>
</template>
`
  const ast = parse(source, 'control.board')

  assert(ast.template.sections.length === 1, 'should have 1 section')
  const nodes = ast.template.sections[0].nodes
  assert(nodes.some(n => n.type === 'each'), 'should have each node')
  assert(nodes.some(n => n.type === 'if'), 'should have if node')
})

// ─── Test 9: 纯文本 + 插值 rawNodes ─────────────────────────────────────

test('text + interpolation rawNodes', () => {
  const source = `
<template>
  Hello {{ name }}, welcome!
</template>
`
  const ast = parse(source, 'textinterp.board')

  assert(ast.template.sections.length === 0, 'should have 0 sections')
  assert(ast.template.rawNodes.length >= 2, 'should have multiple raw nodes')
  assert(ast.template.rawNodes.some(n => n.type === 'text'), 'should have text node')
  assert(ast.template.rawNodes.some(n => n.type === 'interpolation'), 'should have interpolation')
})

// ─── Test 10: <user> and <assistant> shorthand tags ──────────────────────

test('<user> and <assistant> shorthand inside messages section', () => {
  const source = `
<template>
  <messages>
    {{ history }}
    <user>{{ currentMsg }}</user>
    <assistant>{{ lastReply }}</assistant>
  </messages>
</template>
`
  const ast = parse(source, 'shorthand.board')

  assert(ast.template.sections.length === 1, 'should have 1 section')
  assert(ast.template.sections[0].name === 'messages', 'section: messages')

  const nodes = ast.template.sections[0].nodes
  const msgNodes = nodes.filter(n => n.type === 'message')
  assert(msgNodes.length === 2, 'should have 2 message nodes')
  assert(msgNodes[0].role.value === 'user', 'first node role: user')
  assert(msgNodes[1].role.value === 'assistant', 'second node role: assistant')
})

// ─── Test 11: <user> with explicit role override ──────────────────────────

test('<user> with explicit role="system" override', () => {
  const source = `
<template>
  <messages>
    <user role="system">{{ sysMsg }}</user>
  </messages>
</template>
`
  const ast = parse(source, 'role-override.board')
  const nodes = ast.template.sections[0].nodes
  const msgNodes = nodes.filter(n => n.type === 'message')
  assert(msgNodes.length === 1, 'should have 1 message node')
  assert(msgNodes[0].role.value === 'system', 'explicit role override should be respected')
})

// ─── Test 12: no template block ──────────────────────────────────────────

test('no template block', () => {
  const source = `
<script>
let x = 1
</script>
`
  const ast = parse(source, 'notpl.board')

  assert(ast.template === null, 'template should be null')
  assert(typeof ast.script === 'string', 'script should exist')
})

// ─── Nested tags ─────────────────────────────────────────────────────────────

test('nested <if> inside <if> parses correctly', () => {
  const source = `
<template>
  <system>
    <if :condition="outer">
      <if :condition="inner">deep</if>
      shallow
    </if>
  </system>
</template>
`
  const ast = parse(source, 'nested-if.board')
  const section = ast.template.sections.find(s => s.name === 'system')
  assert(section !== undefined, 'system section should exist')
  const outerIf = section.nodes.find(n => n.type === 'if')
  assert(outerIf !== undefined, 'outer <if> should exist')
  const innerIf = outerIf.children.find(n => n.type === 'if')
  assert(innerIf !== undefined, 'inner <if> should exist inside outer <if>')
  const innerText = innerIf.children.find(n => n.type === 'text')
  assert(innerText !== undefined && innerText.value.includes('deep'), 'inner <if> content should be "deep"')
})

test('nested <each> inside <each> parses correctly', () => {
  const source = `
<template>
  <output>
    <each :items="rows" as="row">
      <each :items="row.cells" as="cell">{{ cell }}</each>
    </each>
  </output>
</template>
`
  const ast = parse(source, 'nested-each.board')
  const section = ast.template.sections.find(s => s.name === 'output')
  assert(section !== undefined, 'output section should exist')
  const outerEach = section.nodes.find(n => n.type === 'each')
  assert(outerEach !== undefined, 'outer <each> should exist')
  assert(outerEach.as?.value === 'row', 'outer each alias should be "row"')
  const innerEach = outerEach.children.find(n => n.type === 'each')
  assert(innerEach !== undefined, 'inner <each> should exist inside outer <each>')
  assert(innerEach.as?.value === 'cell', 'inner each alias should be "cell"')
})

// ─── 结果 ──────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(40)}`)
console.log(`Results: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  console.log('\n❌ Some tests failed')
  process.exit(1)
} else {
  console.log('\n✅ All tests passed')
}
