/**
 * template 块解析器
 * 把 <template> 内容解析成节点树
 */

/**
 * @param {string} source - <template>...</template> 内的原始内容
 * @returns {TemplateAST}
 */
export function parseTemplate(source) {
  // 提取三个内容区
  const system = extractSection(source, 'system')
  const messages = extractSection(source, 'messages')
  const user = extractSection(source, 'user')

  // 如果没有显式分区，整个 template 作为 system
  if (!system && !messages && !user) {
    return {
      system: parseNodes(source.trim()),
      messages: null,   // null = 默认带全部历史
      user: null,
    }
  }

  return {
    system: system ? parseNodes(system) : [],
    messages: messages ? parseNodes(messages) : null, // null = 默认带全部历史
    user: user ? parseNodes(user) : [],
  }
}

/**
 * 提取命名 section
 */
function extractSection(source, name) {
  const open = source.indexOf(`<${name}>`)
  if (open === -1) return null
  const contentStart = open + name.length + 2
  const close = source.indexOf(`</${name}>`, contentStart)
  if (close === -1) return null
  return source.slice(contentStart, close)
}

/**
 * 解析模板节点
 * 支持：文本、插值 {{ expr }}、<if>、<each>、<include>、<message>
 */
export function parseNodes(source) {
  const nodes = []
  let i = 0

  while (i < source.length) {
    const interpStart = source.indexOf('{{', i)
    const tagStart = findTagStart(source, i)

    const nextInterp = interpStart === -1 ? Infinity : interpStart
    const nextTag = tagStart === -1 ? Infinity : tagStart
    const next = Math.min(nextInterp, nextTag)

    if (next === Infinity) {
      // 保留内部空白，只去掉首尾换行
      const text = source.slice(i).replace(/^\n+|\n+$/g, '')
      if (text) nodes.push({ type: 'text', value: text })
      break
    }

    // 收前面的文本
    // 保留内部空格（行内插值间距），只去掉首尾换行
    const rawBefore = source.slice(i, next)
    const textBefore = rawBefore.replace(/^\n+|\n+$/g, '')
    if (textBefore) nodes.push({ type: 'text', value: textBefore })

    if (nextInterp <= nextTag) {
      // 插值节点
      const end = source.indexOf('}}', interpStart + 2)
      if (end === -1) throw new Error('Unclosed interpolation {{ }}')
      const expr = source.slice(interpStart + 2, end).trim()
      nodes.push({ type: 'interpolation', expr })
      i = end + 2
    } else {
      // 标签节点
      const tagResult = parseTag(source, tagStart)
      if (tagResult) {
        nodes.push(tagResult.node)
        i = tagResult.end
      } else {
        // 未识别标签，跳过 '<'
        i = tagStart + 1
      }
    }
  }

  return nodes
}

/**
 * 找到下一个已知标签的起始位置
 * 只识别 <if <each <include <message <user <assistant
 */
function findTagStart(source, from) {
  const knownTags = ['if', 'each', 'include', 'message', 'user', 'assistant']
  let earliest = -1
  for (const tag of knownTags) {
    // 开标签
    const idx = source.indexOf(`<${tag}`, from)
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx
    }
  }
  return earliest
}

/**
 * 解析一个标签节点（<if>, <each>, <include>, <message>）
 */
function parseTag(source, start) {
  // 自闭合标签：<include src="..." />
  const selfClose = /^<(include)\s([^>]*?)\/>/i.exec(source.slice(start))
  if (selfClose) {
    const attrs = parseAttrs(selfClose[2])
    return {
      node: { type: 'include', ...attrs },
      end: start + selfClose[0].length,
    }
  }

  // 开放标签：<if>, <each>, <message>
  const openTag = /^<(if|each|message|user|assistant)\s([^>]*)>/i.exec(source.slice(start))
  if (!openTag) return null

  const tagName = openTag[1].toLowerCase()
  const attrs = parseAttrs(openTag[2])
  const contentStart = start + openTag[0].length
  const closeTag = `</${tagName}>`
  const closeIdx = source.indexOf(closeTag, contentStart)
  if (closeIdx === -1) throw new Error(`Unclosed <${tagName}>`)

  const innerSource = source.slice(contentStart, closeIdx)
  const children = parseNodes(innerSource)

  const node = { type: tagName, ...attrs, children }
  return { node, end: closeIdx + closeTag.length }
}

/**
 * 解析属性字符串
 * 支持 :attr="expr"（动态）和 attr="value"（静态）
 */
function parseAttrs(attrStr) {
  const attrs = {}
  const pattern = /(:?[\w-]+)="([^"]*)"/g
  let m
  while ((m = pattern.exec(attrStr)) !== null) {
    const isDynamic = m[1].startsWith(':')
    const key = isDynamic ? m[1].slice(1) : m[1]
    attrs[key] = isDynamic
      ? { type: 'dynamic', expr: m[2] }
      : { type: 'static', value: m[2] }
  }
  return attrs
}

/**
 * @typedef {Object} TemplateAST
 * @property {Node[]|null} system
 * @property {Node[]|null} messages  - null 表示使用默认历史
 * @property {Node[]|null} user
 *
 * @typedef {TextNode|InterpolationNode|IfNode|EachNode|IncludeNode|MessageNode} Node
 */
