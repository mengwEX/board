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

  /** 停止 Runtime，清理资源 */
  async destroy() {
    await this._runtime.stop()
  }
}
