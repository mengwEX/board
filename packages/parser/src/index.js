/**
 * @board/parser
 * 解析 .board 文件为 AST
 */

import { parseYaml } from './yaml.js'
import { parseTemplate } from './template.js'

/**
 * 解析 .board 文件内容
 * @param {string} source - .board 文件内容
 * @param {string} [filename] - 文件名（用于错误提示）
 * @returns {BoardAST}
 */
export function parse(source, filename = '<unknown>') {
  const blocks = extractBlocks(source, filename)

  return {
    filename,
    template: blocks.template ? parseTemplate(blocks.template) : null,
    script: blocks.script ?? null,
    config: blocks.config ? parseYaml(blocks.config, filename) : {},
  }
}

/**
 * 提取三个顶级块的原始内容
 * @param {string} source
 * @param {string} filename
 * @returns {{ template?, script?, config? }}
 */
function extractBlocks(source, filename) {
  const blocks = {}
  // 匹配 <template>, <script>, <config> 顶级块
  // 支持块内有同名嵌套标签（通过计数括号深度）
  const blockNames = ['template', 'script', 'config']

  for (const name of blockNames) {
    const result = extractBlock(source, name, filename)
    if (result !== null) {
      blocks[name] = result
    }
  }

  return blocks
}

/**
 * 提取单个顶级块的内容
 * 正确处理嵌套（如 <template> 内的 <if>）
 */
function extractBlock(source, tagName, filename) {
  const openTag = new RegExp(`<${tagName}(?:\\s[^>]*)?>`, 'i')
  const closeTag = new RegExp(`</${tagName}>`, 'i')

  const openMatch = openTag.exec(source)
  if (!openMatch) return null

  const start = openMatch.index + openMatch[0].length
  let depth = 1
  let i = start

  while (i < source.length && depth > 0) {
    const openIdx = source.indexOf(`<${tagName}`, i)
    const closeIdx = source.indexOf(`</${tagName}>`, i)

    if (closeIdx === -1) {
      throw new ParseError(`Unclosed <${tagName}> block`, filename)
    }

    if (openIdx !== -1 && openIdx < closeIdx) {
      depth++
      i = openIdx + tagName.length + 1
    } else {
      depth--
      if (depth === 0) {
        return source.slice(start, closeIdx)
      }
      i = closeIdx + tagName.length + 3
    }
  }

  throw new ParseError(`Unclosed <${tagName}> block`, filename)
}

export class ParseError extends Error {
  constructor(message, filename) {
    super(`[${filename}] ${message}`)
    this.name = 'ParseError'
    this.filename = filename
  }
}

/**
 * @typedef {Object} BoardAST
 * @property {string} filename
 * @property {TemplateAST|null} template
 * @property {string|null} script
 * @property {Object} config
 */
