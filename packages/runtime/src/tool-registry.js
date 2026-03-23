/**
 * ToolRegistry — Dynamic tool loading for Board.
 *
 * Manages a collection of tools declared in <config> and provides
 * filtered views via byGroup() / byName() / all().
 *
 * Tools in config may carry internal fields (handler, group) that
 * should not be exposed to LLMs. toSchema() strips these out.
 */

const INTERNAL_FIELDS = new Set(['handler', 'group', '_handler'])

export class ToolRegistry {
  /**
   * @param {object[]|null|undefined} toolConfigs - raw tools array from parsed config
   */
  constructor(toolConfigs) {
    /** @type {object[]} */
    this._tools = Array.isArray(toolConfigs) ? toolConfigs : []
  }

  /**
   * Return all tools (public schema only).
   * @returns {object[]}
   */
  all() {
    return this._tools.map(t => this.toSchema(t))
  }

  /**
   * Return tools belonging to any of the given groups (union).
   * A tool belongs to a group if its `group` field (string or string[])
   * includes any of the requested group names.
   *
   * @param {...string} groups
   * @returns {object[]}
   */
  byGroup(...groups) {
    if (groups.length === 0) return []
    const set = new Set(groups)
    return this._tools
      .filter(t => {
        const g = t.group
        if (!g) return false
        if (Array.isArray(g)) return g.some(x => set.has(x))
        return set.has(g)
      })
      .map(t => this.toSchema(t))
  }

  /**
   * Return tools with the given names.
   *
   * @param {...string} names
   * @returns {object[]}
   */
  byName(...names) {
    if (names.length === 0) return []
    const set = new Set(names)
    return this._tools
      .filter(t => set.has(t.name))
      .map(t => this.toSchema(t))
  }

  /**
   * Strip internal fields (handler, group, etc.) from a tool config
   * to produce the schema exposed to the LLM.
   *
   * @param {object} tool
   * @returns {object}
   */
  toSchema(tool) {
    const schema = {}
    for (const [k, v] of Object.entries(tool)) {
      if (!INTERNAL_FIELDS.has(k)) {
        schema[k] = v
      }
    }
    return schema
  }
}
