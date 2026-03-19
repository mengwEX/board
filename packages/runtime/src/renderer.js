/**
 * @promptu/runtime — Template 渲染器
 *
 * 把 TemplateAST + 响应式状态 → 由 template 定义的输出结构
 *
 * 不预设任何 schema，template 中的顶层标签名直接成为输出对象的 key。
 */

/**
 * 渲染整个 template AST
 * @param {import('@promptu/parser').TemplateAST} ast
 * @param {object} state - 响应式状态（script 里的变量）
 * @param {import('./context.js').ContextManager} ctx
 * @returns {any} 由 template 结构决定的输出
 */
export function renderTemplate(ast, state, ctx) {
  if (!ast) {
    return {}
  }

  // 无 section：直接渲染 rawNodes
  if (ast.sections.length === 0 && ast.rawNodes) {
    return renderRawNodes(ast.rawNodes, state, ctx)
  }

  // 有 sections：每个 section 渲染为输出对象的一个 key
  const output = {}
  for (const section of ast.sections) {
    output[section.name] = renderSection(section, state, ctx)
  }
  return output
}

// ─── Section 渲染（智能类型推断）─────────────────────────────────────────

/**
 * 渲染单个 section，智能推断返回类型：
 * 1. 单个 interpolation 且结果为对象/数组 → 直接返回（保留类型）
 * 2. 包含 <message> 节点 → 收集为 [{ role, content }] 数组
 * 3. 其余 → 渲染为 string
 */
function renderSection(section, state, ctx) {
  const { nodes } = section

  // 情况 1：单个 interpolation — 保留原始类型
  if (isSingleInterpolation(nodes)) {
    const value = evalExpr(nodes[0].expr, state)
    if (value !== null && value !== undefined && typeof value === 'object') {
      return value  // 保留对象/数组类型
    }
    // 原始类型也直接返回
    return value
  }

  // 情况 2：包含 <message> 节点 → 收集为消息数组
  if (hasMessageNodes(nodes)) {
    return renderMessagesNodes(nodes, state, ctx)
  }

  // 情况 3：其余 → 渲染为 string
  return renderNodes(nodes, state, ctx).trim()
}

/**
 * 渲染无 section 的 rawNodes
 */
function renderRawNodes(nodes, state, ctx) {
  // 单个 interpolation → 保留类型
  if (isSingleInterpolation(nodes)) {
    return evalExpr(nodes[0].expr, state)
  }
  // 其余 → string
  return renderNodes(nodes, state, ctx).trim()
}

// ─── 类型推断辅助 ────────────────────────────────────────────────────────

/**
 * 判断节点列表是否为"单个插值"
 * 允许前后有空白文本，但有效节点只有一个 interpolation
 */
function isSingleInterpolation(nodes) {
  const meaningful = nodes.filter(n => {
    if (n.type === 'text' && !n.value.trim()) return false
    return true
  })
  return meaningful.length === 1 && meaningful[0].type === 'interpolation'
}

/**
 * 判断节点列表中是否包含 <message> 类型节点（递归检查 <if>/<each> 子节点）
 */
function hasMessageNodes(nodes) {
  return nodes.some(n => {
    if (n.type === 'message') return true
    // <if> and <each> may contain message nodes in their children
    if ((n.type === 'if' || n.type === 'each') && n.children) {
      return hasMessageNodes(n.children)
    }
    return false
  })
}

// ─── 节点渲染 ───────────────────────────────────────────────────────────────

/**
 * 把节点数组渲染成字符串
 */
function renderNodes(nodes, state, ctx) {
  if (!nodes) return ''
  return nodes.map(node => renderNode(node, state, ctx)).join('')
}

function renderNode(node, state, ctx) {
  switch (node.type) {
    case 'text':
      return node.value

    case 'interpolation': {
      const val = evalExpr(node.expr, state)
      if (val === null || val === undefined) return ''
      if (typeof val === 'object') return JSON.stringify(val)
      return String(val)
    }

    case 'if': {
      const cond = node.condition
        ? evalAttr(node.condition, state)
        : false
      return cond ? renderNodes(node.children, state, ctx) : ''
    }

    case 'each': {
      const items = node.items ? evalAttr(node.items, state) : []
      const asName = node.as?.value ?? 'item'
      if (!Array.isArray(items)) return ''
      return items.map(item => {
        const loopState = { ...state, [asName]: item }
        return renderNodes(node.children, loopState, ctx)
      }).join('')
    }

    case 'include': {
      // 子组件渲染留给 Runtime 处理，这里返回占位
      return node._rendered ?? `[include:${node.src?.value ?? '?'}]`
    }

    case 'message': {
      // 在字符串渲染模式下，message 节点渲染为标记文本
      const role = node.role?.value ?? 'user'
      const content = renderNodes(node.children, state, ctx).trim()
      return `[MSG:${role}]${content}[/MSG]`
    }

    default:
      return ''
  }
}

/**
 * 渲染 <message> 节点 → Message 对象数组
 */
function renderMessagesNodes(nodes, state, ctx) {
  const messages = []

  for (const node of nodes) {
    if (node.type === 'interpolation') {
      // {{ history }} 等表达式
      const val = evalExpr(node.expr, state)
      if (Array.isArray(val)) {
        messages.push(...val)
      }
    } else if (node.type === 'message') {
      const role = node.role?.value ?? 'user'
      const content = renderNodes(node.children, state, ctx).trim()
      if (content) messages.push({ role, content })
    } else if (node.type === 'if') {
      const cond = node.condition ? evalAttr(node.condition, state) : false
      if (cond) {
        const sub = renderMessagesNodes(node.children, state, ctx)
        messages.push(...sub)
      }
    } else if (node.type === 'each') {
      const items = node.items ? evalAttr(node.items, state) : []
      const asName = node.as?.value ?? 'item'
      if (Array.isArray(items)) {
        for (const item of items) {
          const loopState = { ...state, [asName]: item }
          const sub = renderMessagesNodes(node.children, loopState, ctx)
          messages.push(...sub)
        }
      }
    } else if (node.type === 'include') {
      // <include src="..."> inside messages section: treat rendered content as a user message
      const content = (node._rendered ?? '').trim()
      if (content) messages.push({ role: 'user', content })
    }
  }

  return messages
}

// ─── 表达式求值 ─────────────────────────────────────────────────────────────

function evalExpr(expr, state) {
  try {
    const fn = new Function(...Object.keys(state), `return (${expr})`)
    return fn(...Object.values(state))
  } catch (e) {
    if (process.env.BOARD_DEBUG) {
      console.warn(`[Board] Template expression error: {{ ${expr} }} — ${e.message}`)
    }
    return ''
  }
}

function evalAttr(attr, state) {
  if (!attr) return undefined
  if (attr.type === 'static') return attr.value
  if (attr.type === 'dynamic') return evalExpr(attr.expr, state)
  return undefined
}
