/**
 * template 块解析器
 * 把 <template> 内容解析成节点树
 *
 * 返回通用 sections 结构：
 * - { sections: [{ name, nodes }] }          — 有顶层标签时
 * - { sections: [], rawNodes: Node[] }       — 无顶层标签时（纯文本/插值）
 */

/**
 * @param {string} source - <template>...</template> 内的原始内容
 * @returns {TemplateAST}
 */
export function parseTemplate(source) {
  const sections = extractSections(source)

  // 无顶层标签：整个 template 作为 rawNodes
  if (sections.length === 0) {
    const trimmed = source.trim()
    return {
      sections: [],
      rawNodes: trimmed ? parseNodes(trimmed) : [],
    }
  }

  return { sections }
}

/**
 * 扫描 <template> 内容，提取所有顶层标签作为 sections。
 * 不预设任何标签名，任意顶层标签都会成为一个 section。
 *
 * 内联标签（<if>, <each>, <include>, <message>, <user>, <assistant>）
 * 不作为 section 顶层标签，它们只出现在 section 内部。
 */
function extractSections(source) {
  const sections = []
  // 控制流标签：不作为 section，只在 section 内部使用
  const inlineTags = new Set(['if', 'each', 'include'])

  // 扫描所有顶层标签
  const tagPattern = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>|<\/([a-zA-Z][\w-]*)>/g
  let match
  let depth = 0
  let currentTag = null
  let contentStart = -1

  while ((match = tagPattern.exec(source)) !== null) {
    const openTag = match[1]
    const closeTag = match[2]

    if (openTag) {
      // 自闭合标签跳过
      if (match[0].endsWith('/>')) continue

      if (depth === 0) {
        // 顶层开标签
        if (inlineTags.has(openTag)) {
          // 内联标签出现在顶层 → 跳过，不作为 section
          // 需要追踪深度以正确跳过其闭合标签
          // 但这里我们不将其视为 section
          // 回退到 "无 section" 情况由外层处理
          continue
        }
        currentTag = openTag
        contentStart = match.index + match[0].length
        depth = 1
      } else if (openTag === currentTag) {
        depth++
      }
    } else if (closeTag) {
      if (closeTag === currentTag) {
        depth--
        if (depth === 0) {
          const content = source.slice(contentStart, match.index)
          sections.push({
            name: currentTag,
            nodes: parseNodes(content.trim()),
          })
          currentTag = null
          contentStart = -1
        }
      }
    }
  }

  return sections
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
 * @property {Section[]} sections - 顶层标签 sections
 * @property {Node[]} [rawNodes] - 无 section 时的原始节点（仅当 sections 为空时存在）
 *
 * @typedef {Object} Section
 * @property {string} name - section 标签名
 * @property {Node[]} nodes - section 内的节点树
 *
 * @typedef {TextNode|InterpolationNode|IfNode|EachNode|IncludeNode|MessageNode} Node
 */
