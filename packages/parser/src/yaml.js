/**
 * YAML 解析工具
 * 包装 js-yaml，提供友好的错误信息
 */

import yaml from 'js-yaml'

/**
 * @param {string} source
 * @param {string} filename
 * @returns {Object}
 */
export function parseYaml(source, filename) {
  try {
    return yaml.load(source) ?? {}
  } catch (e) {
    throw new Error(`[${filename}] Config YAML parse error: ${e.message}`)
  }
}
