/**
 * @promptu/runtime — Context 管理
 *
 * 管理 turn / history / session / drop 四种数据生命周期。
 *
 * - turn    : 只存活当前轮，下一轮 flush 时自动清除
 * - history : 进入对话历史，参与下轮请求组装
 * - session : 整个 session 持久，直到显式清除
 * - drop    : 立即丢弃，不存任何地方
 */

export class ContextManager {
  constructor() {
    this._turn = []       // 当前轮数据，每轮 flush 后清空
    this._history = []    // 历史消息列表
    this._session = {}    // session 级 KV 存储
  }

  // ─── 四种分流 API（供 .board script 调用）────────────────────────────────

  /**
   * 路由到当前轮（下轮自动丢弃）
   * @param {any} data
   * @param {{ label?: string }} [opts]
   */
  turn(data, opts = {}) {
    this._turn.push({ data, label: opts.label ?? null })
  }

  /**
   * 路由到历史记录
   * @param {any} data
   * @param {{ role?: string, priority?: 'high'|'normal'|'low' }} [opts]
   */
  history(data, opts = {}) {
    this._history.push({
      role: opts.role ?? 'tool',
      content: typeof data === 'string' ? data : JSON.stringify(data),
      priority: opts.priority ?? 'normal',
      timestamp: Date.now(),
    })
  }

  /**
   * 路由到 session 存储
   * @param {string} key
   * @param {any} value
   */
  session(key, value) {
    if (typeof key === 'object' && value === undefined) {
      // session({ key: value }) 对象形式
      Object.assign(this._session, key)
    } else {
      this._session[key] = value
    }
  }

  /**
   * 丢弃（显式表达"这个数据不需要"）
   * @param {any} _data
   */
  drop(_data) {
    // 什么都不做，语义明确
  }

  // ─── 内部方法（供 Runtime 调用）────────────────────────────────────────

  /**
   * 获取当前轮数据（用于注入 template 渲染）
   */
  getTurnData() {
    return this._turn.map(t => t.data)
  }

  /**
   * 获取历史消息（用于 <messages> 渲染）
   * @param {number} [limit] 最多取最近 N 条
   */
  getHistory(limit) {
    const h = this._history
    return limit ? h.slice(-limit) : [...h]
  }

  /**
   * 获取 session 值
   * @param {string} key
   */
  getSession(key) {
    return key ? this._session[key] : { ...this._session }
  }

  /**
   * 每轮结束后调用：清空 turn 数据
   */
  flushTurn() {
    this._turn = []
  }

  /**
   * 历史超出 token 预算时，按 priority 裁剪
   * @param {number} maxItems
   */
  trimHistory(maxItems) {
    if (this._history.length <= maxItems) return
    // low priority 先裁
    const sorted = [...this._history].sort((a, b) => {
      const p = { low: 0, normal: 1, high: 2 }
      return p[a.priority] - p[b.priority]
    })
    const remove = sorted.slice(0, this._history.length - maxItems)
    const removeSet = new Set(remove)
    this._history = this._history.filter(h => !removeSet.has(h))
  }
}
