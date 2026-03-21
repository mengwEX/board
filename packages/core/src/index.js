/**
 * @board/core
 *
 * Board SDK
 *
 * Board 承接这一段：
 *   任意输入（LLM 回复、工具结果、用户消息……）
 *     → 触发 .board script 钩子
 *     → 响应式状态更新
 *     → 渲染 <template>
 *     → 返回任意输出
 *
 * 输入格式、输出格式、字段名称 — 全部由使用方在 .board 文件里定义。
 * Board 不预设任何 schema。
 *
 * 基本用法：
 *
 *   const board = await createBoard('./main.board')
 *
 *   const output = await board.update(input)
 *   // input  — 任意结构，由使用方决定
 *   // output — 由 .board <template> 渲染结果决定
 */

import { PromptuRuntime } from '@promptu/runtime'

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 创建 Board 实例。
 *
 * @param {string} boardPath - .board 文件路径
 * @param {object} [opts]
 * @param {boolean} [opts.watch=true] - 监听文件变化，自动热更新
 * @returns {Promise<Board>}
 */
export async function createBoard(boardPath, opts = {}) {
  const runtime = new PromptuRuntime(boardPath, {
    watch: opts.watch ?? true,
  })
  await runtime.start()
  return new Board(runtime)
}

// ─── Board ────────────────────────────────────────────────────────────────────

export class Board {
  constructor(runtime) {
    this._runtime = runtime
  }

  /**
   * 核心接口。
   *
   * 传入任意输入，触发 .board 里对应的 on() 钩子，
   * 响应式状态更新后重新渲染 <template>，返回渲染结果。
   *
   * 输入格式由使用方决定，.board 里的 on() 钩子负责处理。
   * 输出格式由 .board 的 <template> 决定。
   *
   * @param {any} input
   * @returns {Promise<any>}
   */
  async update(input) {
    await this._runtime._triggerHook('update', input)
    return await this._runtime._render()
  }

  /**
   * 运行时切换 .board 文件。
   * @param {string} boardPath
   */
  async load(boardPath) {
    await this._runtime._loadFile(boardPath)
    await this._runtime._triggerHook('mount')
  }

  /** 读取当前响应式状态（调试用）*/
  getState() {
    return this._runtime.getState()
  }

  /** 读取当前 context（history / session / turn 数据，调试用）*/
  getContext() {
    return this._runtime.getContext()
  }

  /**
   * 裁剪历史记录，保留最近 maxItems 条。
   * 低优先级（priority: 'low'）的记录优先被移除。
   *
   * @param {number} maxItems - 保留的最大历史条数
   */
  trimHistory(maxItems) {
    this._runtime._ctx.trimHistory(maxItems)
  }

  /**
   * 从外部触发一个命名事件，等同于 .board script 内调用 emit()。
   * .board script 里通过 on('emit:name', fn) 监听。
   *
   * @param {string} event - 事件名（不含 'emit:' 前缀）
   * @param {any} [payload]
   */
  async emit(event, payload) {
    await this._runtime._emit(event, payload)
  }

  /**
   * 在外部监听运行时事件（lifecycle 或 emit 事件）。
   * 可用于观察 .board script 内部触发的 emit() 调用。
   *
   * 常用事件：
   *   - 'mount'        : board 加载完毕
   *   - 'update'       : board.update() 触发时
   *   - 'destroy'      : board.destroy() 触发时
   *   - 'emit:<name>'  : script 内 emit('name') 触发时
   *
   * @param {string} event
   * @param {Function} fn
   */
  on(event, fn) {
    const handlers = this._runtime._handlers
    if (!handlers[event]) handlers[event] = []
    handlers[event].push(fn)
  }

  /**
   * 移除外部监听器。传入 fn 时只移除该具体函数；不传 fn 时移除该事件的所有监听器。
   *
   * @param {string} event
   * @param {Function} [fn]
   */
  off(event, fn) {
    const handlers = this._runtime._handlers
    if (!handlers[event]) return
    if (fn) {
      handlers[event] = handlers[event].filter(h => h !== fn)
    } else {
      delete handlers[event]
    }
  }

  /** 停止 Runtime，清理资源 */
  async destroy() {
    await this._runtime.stop()
  }
}
