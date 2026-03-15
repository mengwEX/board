/**
 * @promptu/runtime — Template 渲染器
 *
 * 把 TemplateAST + 响应式状态 → { system, messages, tools }
 */

/**
 * 渲染整个 template AST
 * @param {import('@promptu/parser').TemplateAST} ast
 * @param {object} state - 响应式状态（script 里的变量）
 * @param {import('./context.js').ContextManager} ctx
 * @param {object} config - <config> 解析结果
 * @returns {{ system: string, messages: Array, tools: Array }}
 */
export function renderTemplate(ast, state, ctx, config = {}) {
  if (!ast) {
    return { system: '', messages: ctx.getHistory(), tools: config.tools ?? [] }
  }

  // 渲染 system
  const system = ast.system ? renderNodes(ast.system, state, ctx).trim() : ''

  // 渲染 messages
  // null = 使用默认历史（全部带上）
  // 有节点 = 按声明渲染
  let messages
  if (ast.messages === null) {
    messages = ctx.getHistory()
  } else {
    messages = renderMessagesNodes(ast.messages, state, ctx)
  }

  // 渲染 user（当前轮用户消息）
  const userContent = ast.user ? renderNodes(ast.user, state, ctx).trim() : ''
  if (userContent) {
    messages = [...messages, { role: 'user', content: userContent }]
  }

  // turn 数据注入（只这轮用）
  const turnData = ctx.getTurnData()
  if (turnData.length > 0) {
    messages = [...messages, {
      role: 'tool',
      content: turnData.map(d => typeof d === 'string' ? d : JSON.stringify(d)).join('\n')
    }]
  }

  return {
    system,
    messages,
    tools: config.tools ?? [],
  }
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

    case 'interpolation':
      return evalExpr(node.expr, state)

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
      // Runtime 在渲染前会递归解析 include
      return node._rendered ?? `[include:${node.src?.value ?? '?'}]`
    }

    case 'message': {
      // <message role="user">...</message>
      const role = node.role?.value ?? 'user'
      const content = renderNodes(node.children, state, ctx).trim()
      return `[MSG:${role}]${content}[/MSG]`
    }

    default:
      return ''
  }
}

/**
 * 渲染 <messages> 区块 → Message 对象数组
 */
function renderMessagesNodes(nodes, state, ctx) {
  const messages = []

  for (const node of nodes) {
    if (node.type === 'interpolation') {
      // {{ history.last(5) }} 这类表达式
      const val = evalExpr(node.expr, state)
      if (Array.isArray(val)) {
        messages.push(...val)
      }
    } else if (node.type === 'message') {
      const role = node.role?.value ?? 'user'
      const content = renderNodes(node.children, state, ctx).trim()
      if (content) messages.push({ role, content })
    } else if (node.type === 'each') {
      const items = node.items ? evalAttr(node.items, state) : []
      const asName = node.as?.value ?? 'msg'
      if (Array.isArray(items)) {
        for (const item of items) {
          const loopState = { ...state, [asName]: item }
          const sub = renderMessagesNodes(node.children, loopState, ctx)
          messages.push(...sub)
        }
      }
    }
  }

  return messages
}

// ─── 表达式求值 ─────────────────────────────────────────────────────────────

function evalExpr(expr, state) {
  try {
    const fn = new Function(...Object.keys(state), `return (${expr})`)
    return fn(...Object.values(state))
  } catch {
    return ''
  }
}

function evalAttr(attr, state) {
  if (!attr) return undefined
  if (attr.type === 'static') return attr.value
  if (attr.type === 'dynamic') return evalExpr(attr.expr, state)
  return undefined
}
