/**
 * @board/core
 *
 * Board SDK — 承接 LLM 回复 → 工具执行 → 下一次请求拼接。
 *
 * Board 只管这一段：
 *   LLM 回复（text / tool_calls）
 *     → 执行工具
 *     → 触发 .board script 钩子
 *     → 响应式渲染
 *     → 返回下一次请求体 { system, messages, tools }
 *
 * Board 不管：如何调 LLM、HTTP 连接、对话循环。
 * 这些由调用方自己做。
 *
 * 最简用法：
 *
 *   const board = await createBoard('./main.board')
 *
 *   // 用户消息 → 拿到第一次请求体
 *   const req = await board.update({ role: 'user', content: '你好' })
 *   // req = { system, messages, tools } → 调用方自己发给 LLM
 *
 *   // LLM 回复 → board 处理 → 拿到下一次请求体
 *   const nextReq = await board.update(llmResponse)
 */

import { PromptuRuntime } from '@promptu/runtime'

// ─── 公开 API ─────────────────────────────────────────────────────────────────

/**
 * 创建一个 Board 实例。
 *
 * @param {string} boardPath - .board 文件路径
 * @param {BoardOptions} [opts]
 * @returns {Promise<Board>}
 */
export async function createBoard(boardPath, opts = {}) {
  const runtime = new PromptuRuntime(boardPath, {
    watch: opts.watch ?? true,
  })

  await runtime.start()

  return new Board(runtime, opts)
}

// ─── Board 类 ─────────────────────────────────────────────────────────────────

export class Board {
  /**
   * @param {PromptuRuntime} runtime
   * @param {BoardOptions} opts
   */
  constructor(runtime, opts = {}) {
    this._runtime = runtime
    this._opts = opts
  }

  /**
   * 核心接口：输入 LLM 回复或用户消息，返回下一次 LLM 请求体。
   *
   * 输入格式：
   *   - 用户消息：{ role: 'user', content: '...' }
   *   - LLM 文本回复：{ role: 'assistant', content: '...' }
   *   - LLM tool_calls 回复：{ role: 'assistant', tool_calls: [...] }
   *   - 原始 OpenAI 格式都可以直接传
   *
   * 输出格式：
   *   { system: string, messages: Array, tools: Array }
   *   可以直接作为下一次 LLM API 调用的请求体。
   *
   * @param {LLMMessage | LLMResponse} input
   * @returns {Promise<LLMRequest>}
   */
  async update(input) {
    const { role, content, tool_calls } = input ?? {}

    if (role === 'user') {
      // 用户消息
      return await this._runtime.processUserMessage(content ?? '')
    }

    if (role === 'assistant' || tool_calls) {
      // LLM 回复（文本或 tool_calls）
      return await this._runtime.process({
        content: content ?? null,
        tool_calls: tool_calls ?? [],
      })
    }

    // 兜底：直接渲染当前状态
    return this._runtime._render()
  }

  /**
   * 加载/切换 .board 文件。
   * 适用于需要在运行时切换不同 board 的场景。
   *
   * @param {string} boardPath
   */
  async load(boardPath) {
    await this._runtime._loadFile(boardPath)
    await this._runtime._triggerHook('mount')
  }

  /**
   * 读取当前响应式状态（调试用）。
   * @returns {object}
   */
  getState() {
    return this._runtime.getState()
  }

  /**
   * 读取当前 context（调试用）。
   * @returns {{ history: Array, session: object, turn: Array }}
   */
  getContext() {
    return this._runtime.getContext()
  }

  /**
   * 停止 Runtime（清理文件监听等）。
   */
  async destroy() {
    await this._runtime.stop()
  }
}

// ─── 类型文档 ───────────��─────────────────────────────────────────────────────

/**
 * @typedef {object} BoardOptions
 * @property {boolean} [watch=true] - 是否监听 .board 文件变化并热更新
 */

/**
 * @typedef {object} LLMRequest
 * @property {string} system - system prompt
 * @property {Array}  messages - 消息列表
 * @property {Array}  tools - 工具列表
 */

/**
 * @typedef {object} LLMMessage
 * @property {'user'|'assistant'|'tool'} role
 * @property {string} [content]
 * @property {Array}  [tool_calls]
 */
