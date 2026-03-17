/**
 * @promptu/runtime - Promptu Runtime
 *
 * Generic reactive template engine:
 *   1. Load .board file (parse to AST)
 *   2. Execute <script> (establish reactive state + register hooks)
 *   3. board.update(input) -> trigger on('update') -> render <template>
 *   4. Return output structure defined by template
 *
 * Board does not preset any input/output schema.
 * Does not parse input format, does not execute tools, does not call LLM.
 */

import { readFile, watch } from 'fs/promises'
import { resolve, dirname } from 'path'
import { parse } from '@promptu/parser'
import { ContextManager } from './context.js'
import { renderTemplate } from './renderer.js'

export class PromptuRuntime {
  /**
   * @param {string} entryPath - entry .board file path
   * @param {object} [opts]
   * @param {boolean} [opts.watch=true] - watch file changes
   */
  constructor(entryPath, opts = {}) {
    this._entryPath = resolve(entryPath)
    this._watchEnabled = opts.watch ?? true

    this._ast = null
    this._config = {}
    this._state = {}
    this._handlers = {}

    this._ctx = new ContextManager()
    this._watcher = null
  }

  // --- Lifecycle ---

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

  // --- File loading & hot reload ---

  async _loadFile(filePath) {
    const source = await readFile(filePath, 'utf8')
    const ast = parse(source, filePath)

    this._ast = ast
    this._config = ast.config ?? {}

    this._handlers = {}
    this._state = {}

    if (ast.script) {
      await this._execScript(ast.script, filePath)
    }
  }

  _startWatch() {
    const dir = dirname(this._entryPath);

    (async () => {
      try {
        const watcher = watch(dir, { recursive: true })
        this._watcher = watcher
        for await (const event of watcher) {
          if (event.filename && event.filename.endsWith('.board')) {
            const changed = resolve(dir, event.filename)
            if (changed === this._entryPath) {
              console.log('[Promptu] File changed, reloading: ' + event.filename)
              try {
                await this._loadFile(this._entryPath)
                await this._triggerHook('mount')
              } catch (e) {
                console.error('[Promptu] Reload failed: ' + e.message)
              }
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('[Promptu] Watch error:', e)
        }
      }
    })()
  }

  // --- Script execution ---

  async _execScript(scriptSource, filePath) {
    const runtime = this

    const scriptAPI = {
      on: (event, fn) => {
        if (!runtime._handlers[event]) runtime._handlers[event] = []
        runtime._handlers[event].push(fn)
      },
      emit: (event, payload) => {
        runtime._emit(event, payload)
      },
      inject: (key) => {
        return runtime._ctx.getSession(key)
      },
      turn: (data, opts) => runtime._ctx.turn(data, opts),
      history: (data, opts) => runtime._ctx.history(data, opts),
      session: (key, value) => runtime._ctx.session(key, value),
      drop: (data) => runtime._ctx.drop(data),
      __state__: this._state,
    }

    const topLevelNames = extractTopLevelNames(scriptSource)

    // Rewrite let/const/var declarations to __state__ property access
    // so that on() hook modifications directly update this._state
    let rewrittenScript = scriptSource

    for (const name of topLevelNames) {
      // let x = value  ->  __state__.x = value
      rewrittenScript = rewrittenScript.replace(
        new RegExp('^(let|const|var)\\s+' + name + '\\s*=', 'gm'),
        '__state__.' + name + ' ='
      )
      // let x  (no init)  ->  __state__.x = undefined
      rewrittenScript = rewrittenScript.replace(
        new RegExp('^(let|const|var)\\s+' + name + '\\s*$', 'gm'),
        '__state__.' + name + ' = undefined'
      )
    }

    // Replace standalone identifier references with __state__.name
    for (const name of topLevelNames) {
      rewrittenScript = rewrittenScript.replace(
        new RegExp('(?<![.\\w])' + name + '(?![\\w:])', 'g'),
        '__state__.' + name
      )
    }

    // function declarations -> __state__.name = function
    rewrittenScript = rewrittenScript.replace(
      /^(async\s+)?function\s+(\w+)/gm,
      (match, asyncPrefix, fnName) => {
        if (topLevelNames.includes(fnName)) {
          return '__state__.' + fnName + ' = ' + (asyncPrefix || '') + 'function ' + fnName
        }
        return match
      }
    )

    const wrappedScript =
      'const { on, emit, inject, turn, history, session, drop, __state__ } = __api__;\n' +
      rewrittenScript

    try {
      const AsyncFn = Object.getPrototypeOf(async function(){}).constructor
      const fn = new AsyncFn('__api__', wrappedScript)
      await fn(scriptAPI)
    } catch (e) {
      console.error('[Promptu] Script exec failed (' + filePath + '): ' + e.message)
      throw e
    }
  }

  // --- Render ---

  _render() {
    return renderTemplate(
      this._ast?.template ?? null,
      this._state,
      this._ctx
    )
  }

  // --- Hook trigger ---

  async _triggerHook(event, payload) {
    const fns = this._handlers[event] ?? []
    for (const fn of fns) {
      try {
        await fn(payload)
      } catch (e) {
        console.error('[Promptu] on(\'' + event + '\') failed: ' + e.message)
      }
    }
  }

  _emit(event, payload) {
    this._triggerHook('emit:' + event, payload)
  }

  // --- Debug ---

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

// --- Utilities ---

/**
 * Extract top-level let/const/function/async function declaration names from script source
 */
function extractTopLevelNames(source) {
  const names = new Set()
  for (const m of source.matchAll(/^(?:let|const|var)\s+(\w+)/gm)) {
    names.add(m[1])
  }
  for (const m of source.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) {
    names.add(m[1])
  }
  return [...names]
}
