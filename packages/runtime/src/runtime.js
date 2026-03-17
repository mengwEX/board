/**
 * @promptu/runtime — Promptu Runtime
 *
 * 接管从 LLM 回复 → 下一次 LLM 请求的完整区间：
 *   1. 接收 LLM 回复（text / tool_call / exec）
 *   2. 自己执行工具（按 config.tools 找 handler）
 *   3. 触发 .board script 里的 on() 钩子
 *   4. 响应式状态变化 → 重新渲染 template
 *   5. 输出 { system, messages, tools }
 *
 * 文件即接入：watch 目录，.board 变化立即重新加载，无需重启。
 */

import { readFile, watch } from 'fs/promises'
import { resolve, dirname } from 'path'
import { parse } from '@promptu/parser'
import { ContextManager } from './context.js'
import { renderTemplate } from './renderer.js'

export class PromptuRuntime {
  /**
   * @param {string} entryPath - 入口 .board 文件路径
   * @param {object} [opts]
   * @param {boolean} [opts.watch=true] - 是否监听文件变化
   */
  constructor(entryPath, opts = {}) {
    this._entryPath = resolve(entryPath)
    this._watchEnabled = opts.watch ?? true

    this._ast = null         // 当前解析的 AST
    this._config = {}        // <config> 内容
    this._state = {}         // 响应式状态（script 里的 let 变量）
    this._handlers = {}      // on() 注册的钩子：{ eventName: [fn] }
    this._toolHandlers = {}  // config.tools 里的 handler 函数

    this._ctx = new ContextManager()
    this._scriptContext = null  // script 执行上下文

    this._watcher = null
  }

  // ─── 生命周期 ────────────────────────────────────────────────────────────

  async start() {
    await this._loadFile(this._entryPath)
    if (this._watchEnabled) {
      this._startWatch()
    }
    await this._triggerHook('mount')
  }

  async stop() {
    if (this._watcher) {
      this._watcher.abort?.()
    }
    await this._triggerHook('destroy')
  }

  // ─── 文件加载与热更新 ────────────────────────────────────────────────────

  async _loadFile(filePath) {
    const source = await readFile(filePath, 'utf8')
    const ast = parse(source, filePath)

    this._ast = ast
    this._config = ast.config ?? {}

    // 重置 script 上下文并执行
    this._handlers = {}
    this._toolHandlers = {}
    this._state = {}

    if (ast.script) {
      await this._execScript(ast.script, filePath)
    }

    // 从 config.tools 收集 handler 映射
    this._registerToolHandlers()
  }

  _startWatch() {
    const dir = dirname(this._entryPath);

    (async () => {
      try {
        const watcher = watch(dir, { recursive: true })
        this._watcher = watcher
        for await (const event of watcher) {
          if (event.filename?.endsWith('.board')) {
            const changed = resolve(dir, event.filename)
            // 仅当是入口文件或 include 的子文件时重新加载
            if (changed === this._entryPath) {
              console.log(`[Promptu] 检测到变化，重新加载：${event.filename}`)
              try {
                await this._loadFile(this._entryPath)
                await this._triggerHook('mount')
              } catch (e) {
                console.error(`[Promptu] 重新加载失败：${e.message}`)
              }
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('[Promptu] 文件监听异常：', e)
        }
      }
    })()
  }

  // ─── Script 执行 ───────────────────────────────────────────────────────��

  async _execScript(scriptSource, filePath) {
    // 构建 script 的执行沙箱
    // script 里的 let 变量通过 Proxy 实现响应式
    const stateProxy = new Proxy(this._state, {
      set: (target, key, value) => {
        target[key] = value
        // 响应式：状态变化后无需手动触发，render 时直接读最新值
        return true
      }
    })

    const runtime = this

    // 注入给 script 的 API
    const scriptAPI = {
      // 生命周期钩子注册
      on: (event, fn) => {
        if (!runtime._handlers[event]) runtime._handlers[event] = []
        runtime._handlers[event].push(fn)
      },

      // 组件通信
      emit: (event, payload) => {
        runtime._emit(event, payload)
      },
      inject: (key) => {
        // 从 session 或父组件获取注入值
        return runtime._ctx.getSession(key)
      },

      // context 分流 API（透传到 ContextManager）
      turn: (data, opts) => runtime._ctx.turn(data, opts),
      history: (data, opts) => runtime._ctx.history(data, opts),
      session: (key, value) => runtime._ctx.session(key, value),
      drop: (data) => runtime._ctx.drop(data),
    }

    // Script 执行策略：
    // 把整个 script 包在一个 async 函数里，末尾自动 return 所有顶层变量和函数。
    // Parser 阶段提取顶层声明名称，Runtime 用来收集 exports。
    const topLevelNames = extractTopLevelNames(scriptSource)

    const moduleScript = `
      const { on, emit, inject, turn, history, session, drop } = __api__;
      ${scriptSource}
      // 自动 export 所有顶层声明
      return { ${topLevelNames.join(', ')} }
    `

    try {
      const AsyncFn = Object.getPrototypeOf(async function(){}).constructor
      const fn = new AsyncFn('__api__', moduleScript)
      const exports = await fn(scriptAPI)

      // 把 exports 合并到 state（排除 API 名称）
      const apiKeys = new Set(['on','emit','inject','turn','history','session','drop'])
      for (const [k, v] of Object.entries(exports ?? {})) {
        if (!apiKeys.has(k)) {
          this._state[k] = v
        }
      }
    } catch (e) {
      console.error(`[Promptu] Script 执行失败 (${filePath}): ${e.message}`)
      throw e
    }
  }

  // ─── 工具注册 ────────────────────────────────────────────────────────────

  _registerToolHandlers() {
    const tools = this._config.tools ?? []
    for (const tool of tools) {
      if (tool.handler && this._state[tool.handler]) {
        this._toolHandlers[tool.name] = this._state[tool.handler]
      }
    }
  }

  // ─── 主循环：处理 LLM 回复 ───────────────────────────────────────────────

  /**
   * 接收 LLM 的原始回复，完整处理后返回下一轮请求内容
   *
   * @param {object} llmResponse - LLM 原始回复
   * @param {string} [llmResponse.content] - 文本回复
   * @param {Array}  [llmResponse.tool_calls] - 工具调用列表
   * @returns {Promise<{ system: string, messages: Array, tools: Array }>}
   */
  async process(llmResponse) {
    // 每轮开始前清空 turn 数据
    this._ctx.flushTurn()

    const { content, tool_calls } = llmResponse

    // 情况一：普通文本回复
    if (content && (!tool_calls || tool_calls.length === 0)) {
      await this._triggerHook('llm_response', { content, finish_reason: 'stop' })
    }

    // 情况二：tool_call（func call）
    if (tool_calls && tool_calls.length > 0) {
      for (const tc of tool_calls) {
        const result = await this._executeTool(tc)
        await this._triggerHook('tool_response', result)
      }
    }

    // 渲染下一轮请求
    return this._render()
  }

  /**
   * 接收用户消息，触发钩子后返回下一轮请求
   * @param {string} userMessage
   * @returns {Promise<{ system: string, messages: Array, tools: Array }>}
   */
  async processUserMessage(userMessage) {
    this._ctx.flushTurn()
    this._state.currentInput = userMessage
    await this._triggerHook('message', { content: userMessage })
    return this._render()
  }

  // ─── 工具执行 ────────────────────────────────────────────────────────────

  async _executeTool(toolCall) {
    const { name, arguments: args } = toolCall
    const parsedArgs = typeof args === 'string' ? JSON.parse(args) : args

    const handler = this._toolHandlers[name]
    if (!handler) {
      console.warn(`[Promptu] 工具未找到 handler: ${name}`)
      return { name, error: `Tool "${name}" has no handler`, args: parsedArgs }
    }

    try {
      const result = await handler(parsedArgs)
      return { name, result, args: parsedArgs }
    } catch (e) {
      console.error(`[Promptu] 工具执行失败 (${name}): ${e.message}`)
      return { name, error: e.message, args: parsedArgs }
    }
  }

  // ─── 渲染 ────────────────────────────────────────────────────────────────

  _render() {
    return renderTemplate(
      this._ast?.template ?? null,
      this._state,
      this._ctx,
      this._config
    )
  }

  // ─── 钩子触发 ────────────────────────────────────────────────────────────

  async _triggerHook(event, payload) {
    const fns = this._handlers[event] ?? []
    for (const fn of fns) {
      try {
        await fn(payload)
      } catch (e) {
        console.error(`[Promptu] on('${event}') 执行失败: ${e.message}`)
      }
    }
  }

  _emit(event, payload) {
    // 跨实例通信：当前版本将 emit 路由为内部钩子事件
    // 未来可扩展为进程级 EventBus，支持多实例间通信
    this._triggerHook(`emit:${event}`, payload)
  }

  // ─── 调试 ────────────────────────────────────────────────────────────────

  getState() {
    return { ...this._state }
  }

  getContext() {
    return {
      history: this._ctx.getHistory(),
      session: this._ctx.getSession(),
      turn: this._ctx.getTurnData(),
    }
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

/**
 * 从 script 源码中提取顶层 let/const/function/async function 的声明名称
 * 用于在执行后自动 export 到 state
 */
function extractTopLevelNames(source) {
  const names = new Set()
  // let / const / var
  for (const m of source.matchAll(/^(?:let|const|var)\s+(\w+)/gm)) {
    names.add(m[1])
  }
  // function xxx / async function xxx
  for (const m of source.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) {
    names.add(m[1])
  }
  return [...names]
}
