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
    this._watchAbortController = null
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
    if (this._watchAbortController) {
      this._watchAbortController.abort()
      this._watchAbortController = null
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
    const dir = dirname(this._entryPath)
    const ac = new AbortController()
    this._watchAbortController = ac

    ;(async () => {
      try {
        const watcher = watch(dir, { recursive: true, signal: ac.signal })
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

    // All context API names available in script scope.
    const ALL_API_NAMES = ['on', 'emit', 'inject', 'turn', 'history', 'session', 'drop']

    const topLevelNames = extractTopLevelNames(scriptSource)

    // API names that the user also declared as state variables.
    // These conflict with the destructured API bindings, so we must NOT
    // destructure them — instead expose them through __api__.<name>.
    const conflictingApiNames = new Set(
      ALL_API_NAMES.filter(name => topLevelNames.includes(name))
    )

    // Non-conflicting API names can be safely destructured into scope.
    const safeApiNames = ALL_API_NAMES.filter(name => !conflictingApiNames.has(name))

    let rewrittenScript = scriptSource

    // Step 1: Rewrite let/const/var declarations to __state__ property access
    // so that on() hook modifications directly update this._state.
    // Do this BEFORE identifier substitution to avoid double-rewriting.
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

    // Step 2: For conflicting names, rewrite API *calls* (name followed by `(`)
    // to use __api__.<name> BEFORE the general state-var substitution, so we can
    // distinguish "call site" (API) from "read/write" (state var).
    for (const name of conflictingApiNames) {
      // name(...) → __api__.name(...)  (not preceded by . or word char)
      rewrittenScript = rewrittenScript.replace(
        new RegExp('(?<![.\\w])' + name + '(?=\\s*\\()', 'g'),
        '__api__.' + name
      )
    }

    // Step 3: Replace remaining bare identifier references with __state__.name.
    // For non-conflicting API names: they're in scope as destructured consts — skip.
    // For conflicting API names: API call sites are already __api__.xxx; remaining
    //   bare references are state-var reads/writes → rewrite to __state__.xxx.
    //
    // Two passes per name:
    //   a) spread syntax: `...name` → `...__state__.name`
    //      (lookbehind can't distinguish `...` from `.`, so handle explicitly first)
    //   b) remaining bare references: not preceded by `.` or word char
    const safeApiNameSet = new Set(safeApiNames)
    for (const name of topLevelNames) {
      if (safeApiNameSet.has(name)) continue  // safely destructured in scope, leave as-is
      // Pass (a): spread operator `...name` → `...__state__.name`
      rewrittenScript = rewrittenScript.replace(
        new RegExp('\\.\\.\\.' + name + '(?![\\w])', 'g'),
        '...__state__.' + name
      )
      // Pass (b): other bare references not preceded by `.` or word char
      rewrittenScript = rewrittenScript.replace(
        new RegExp('(?<![.\\w])' + name + '(?![\\w:])', 'g'),
        '__state__.' + name
      )
    }

    // Step 4: function declarations -> __state__.name = function
    rewrittenScript = rewrittenScript.replace(
      /^(async\s+)?function\s+(\w+)/gm,
      (match, asyncPrefix, fnName) => {
        if (topLevelNames.includes(fnName)) {
          return '__state__.' + fnName + ' = ' + (asyncPrefix || '') + 'function ' + fnName
        }
        return match
      }
    )

    // Destructure only safe (non-conflicting) API names into scope.
    // Conflicting names remain accessible as __api__.<name>.
    const destructureList = [...safeApiNames, '__state__'].join(', ')
    const wrappedScript =
      `const { ${destructureList} } = __api__;\n` +
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

  async _render() {
    // Pre-pass: resolve <include> nodes before synchronous render
    if (this._ast?.template) {
      await this._resolveIncludes(this._ast.template, dirname(this._entryPath))
    }
    const result = renderTemplate(
      this._ast?.template ?? null,
      this._state,
      this._ctx
    )
    // Flush turn-scoped data after each render cycle
    this._ctx.flushTurn()
    return result
  }

  /**
   * Recursively resolve <include src="..."> nodes in the template AST.
   * Reads the referenced file and stores its content in node._rendered.
   * @param {object} templateAst
   * @param {string} baseDir
   */
  async _resolveIncludes(templateAst, baseDir) {
    const allNodes = []
    if (templateAst.rawNodes) allNodes.push(...templateAst.rawNodes)
    for (const section of templateAst.sections ?? []) {
      allNodes.push(...(section.nodes ?? []))
    }
    await this._resolveIncludesInNodes(allNodes, baseDir)
  }

  async _resolveIncludesInNodes(nodes, baseDir) {
    if (!nodes) return
    for (const node of nodes) {
      if (node.type === 'include') {
        const srcAttr = node.src?.value ?? node.src
        if (srcAttr) {
          const filePath = resolve(baseDir, srcAttr)
          try {
            node._rendered = await readFile(filePath, 'utf8')
          } catch (e) {
            console.warn(`[Board] <include src="${srcAttr}"> failed: ${e.message}`)
            node._rendered = `[include error: ${srcAttr}]`
          }
        }
      }
      // Recurse into children
      if (node.children) await this._resolveIncludesInNodes(node.children, baseDir)
    }
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

  // Simple identifier: let x, const x, var x
  for (const m of source.matchAll(/^(?:let|const|var)\s+(\w+)/gm)) {
    names.add(m[1])
  }

  // Destructuring: const { a, b } = ... or const { a: renamed } = ...
  for (const m of source.matchAll(/^(?:let|const|var)\s+\{([^}]+)\}/gm)) {
    for (const part of m[1].split(',')) {
      // Handle "key: alias" — we want the alias (the local name)
      const colonIdx = part.indexOf(':')
      const localPart = colonIdx !== -1 ? part.slice(colonIdx + 1) : part
      const name = localPart.trim().replace(/\s*=.*$/, '') // strip default value
      if (/^\w+$/.test(name)) names.add(name)
    }
  }

  // Array destructuring: const [a, b] = ...
  for (const m of source.matchAll(/^(?:let|const|var)\s+\[([^\]]+)\]/gm)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().replace(/\s*=.*$/, '')
      if (/^\w+$/.test(name)) names.add(name)
    }
  }

  // Function declarations
  for (const m of source.matchAll(/^(?:async\s+)?function\s+(\w+)/gm)) {
    names.add(m[1])
  }

  return [...names]
}
