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
import { ToolRegistry } from './tool-registry.js'

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
    this._toolRegistry = new ToolRegistry(null)
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
    this._toolRegistry = new ToolRegistry(this._config.tools)

    this._handlers = {}
    this._state = {}

    // Update entry path so that hot-reload (and subsequent _startWatch calls)
    // always track the most recently loaded file.
    const prevDir = dirname(this._entryPath)
    this._entryPath = resolve(filePath)
    const newDir = dirname(this._entryPath)

    // If the new file is in a different directory and watch is active,
    // restart the watcher so it covers the new directory.
    if (this._watchEnabled && this._watchAbortController && newDir !== prevDir) {
      this._watchAbortController.abort()
      this._watchAbortController = null
      this._startWatch()
    }

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
          if (!event.filename) continue
          const changed = resolve(dir, event.filename)
          // Reload when the .board entry file changes, or when any
          // non-.board file in the same directory tree changes (e.g.
          // included .txt / .md prompt files).
          const isBoardFile = event.filename.endsWith('.board')
          const isEntryFile = isBoardFile && changed === this._entryPath
          const isIncludedFile = !isBoardFile
          if (isEntryFile || isIncludedFile) {
            console.log('[Board] File changed, reloading: ' + event.filename)
            try {
              await this._loadFile(this._entryPath)
              await this._triggerHook('mount')
            } catch (e) {
              console.error('[Board] Reload failed: ' + e.message)
            }
          }
        }
      } catch (e) {
        if (e.name !== 'AbortError') {
          console.error('[Board] Watch error:', e)
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
      emit: async (event, payload) => {
        await runtime._emit(event, payload)
      },
      inject: (key) => {
        return runtime._ctx.getSession(key)
      },
      turn: (data, opts) => runtime._ctx.turn(data, opts),
      history: (data, opts) => runtime._ctx.history(data, opts),
      session: (key, value) => runtime._ctx.session(key, value),
      drop: (data) => runtime._ctx.drop(data),
      // tool registry APIs
      toolsByGroup: (...groups) => runtime._toolRegistry.byGroup(...groups),
      toolsByName: (...names) => runtime._toolRegistry.byName(...names),
      allTools: () => runtime._toolRegistry.all(),
      // runtime memory APIs
      memory: (key, value) => runtime._ctx.memory(key, value),
      getMemory: (key) => runtime._ctx.getMemory(key),
      __state__: this._state,
    }

    // All context API names available in script scope.
    const ALL_API_NAMES = [
      'on', 'emit', 'inject', 'turn', 'history', 'session', 'drop',
      'toolsByGroup', 'toolsByName', 'allTools',
      'memory', 'getMemory',
    ]

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
    //
    // Handles three forms:
    //   a) Single:  let x = value  →  __state__.x = value
    //   b) No-init: let x          →  __state__.x = undefined
    //   c) Multi:   let a = 1, b = 2  →  __state__.a = 1; __state__.b = 2
    //
    // Destructuring (let { a } = ..., let [a] = ...) is NOT rewritten here;
    // those variables are still captured via identifier substitution in Step 3.
    rewrittenScript = rewrittenScript.replace(
      /^(let|const|var)\s+(.+)$/gm,
      (fullMatch, keyword, rest) => {
        // Skip destructuring declarations — leave them as-is; Step 3 handles the identifiers
        const trimmedRest = rest.trimStart()
        if (trimmedRest.startsWith('{') || trimmedRest.startsWith('[')) return fullMatch

        // Split into individual declarators at top-level commas
        const declarators = splitTopLevelCommas(rest)
        const rewrites = declarators.map(decl => {
          const t = decl.trim()
          const eqIdx = t.indexOf('=')
          if (eqIdx === -1) {
            // No initialiser: let x  →  __state__.x = undefined
            const nameMatch = t.match(/^(\w+)/)
            if (!nameMatch || !topLevelNames.includes(nameMatch[1])) return decl
            return `__state__.${nameMatch[1]} = undefined`
          }
          const nameMatch = t.slice(0, eqIdx).trim().match(/^(\w+)$/)
          if (!nameMatch || !topLevelNames.includes(nameMatch[1])) return decl
          return `__state__.${nameMatch[1]} =${t.slice(eqIdx + 1)}`
        })
        return rewrites.join(';\n')
      }
    )

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
      console.error('[Board] Script exec failed (' + filePath + '): ' + e.message)
      throw e
    }
  }

  // --- Render ---

  async _render() {
    // Pre-pass: resolve <include> nodes before synchronous render
    if (this._ast?.template) {
      await this._resolveIncludes(this._ast.template, dirname(this._entryPath))
    }
    // Expose getMemory in template expression scope (read-only, non-conflicting)
    const stateWithMemory = {
      getMemory: (key) => this._ctx.getMemory(key),
      ...this._state,
    }
    const result = renderTemplate(
      this._ast?.template ?? null,
      stateWithMemory,
      this._ctx
    )
    // Flush turn-scoped data after each render cycle
    this._ctx.flushTurn()
    return result
  }

  /**
   * Recursively resolve <include src="..."> nodes in the template AST.
   * Reads the referenced file and stores its content in node._rendered.
   * Supports both static src="path" and dynamic :src="expr" attributes.
   * @param {object} templateAst
   * @param {string} baseDir
   */
  async _resolveIncludes(templateAst, baseDir) {
    const allNodes = []
    if (templateAst.rawNodes) allNodes.push(...templateAst.rawNodes)
    for (const section of templateAst.sections ?? []) {
      allNodes.push(...(section.nodes ?? []))
    }
    await this._resolveIncludesInNodes(allNodes, baseDir, this._state)
  }

  async _resolveIncludesInNodes(nodes, baseDir, state) {
    if (!nodes) return
    for (const node of nodes) {
      if (node.type === 'include') {
        // T15: Conditional include — evaluate :if="expr" before loading
        const ifAttr = node.if
        if (ifAttr) {
          let condValue
          try {
            const stateKeys = Object.keys(state)
            const fn = new Function(...stateKeys, `return !!(${ifAttr.type === 'dynamic' ? ifAttr.expr : JSON.stringify(ifAttr.value)})`)
            condValue = fn(...Object.values(state))
          } catch (e) {
            if (process.env.BOARD_DEBUG) {
              console.warn(`[Board] <include :if="..."> eval error: ${e.message}`)
            }
            condValue = false
          }
          if (!condValue) {
            node._rendered = ''
            continue
          }
        }

        const src = node.src
        let srcAttr
        if (src?.type === 'static') {
          srcAttr = src.value
        } else if (src?.type === 'dynamic') {
          // Evaluate dynamic :src="expr" against current state
          try {
            const stateKeys = Object.keys(state)
            const fn = new Function(...stateKeys, `return (${src.expr})`)
            srcAttr = fn(...Object.values(state))
          } catch (e) {
            if (process.env.BOARD_DEBUG) {
              console.warn(`[Board] <include :src="${src.expr}"> eval error: ${e.message}`)
            }
          }
        } else if (typeof src === 'string') {
          // Fallback for bare string (should not occur, but be defensive)
          srcAttr = src
        }
        if (srcAttr) {
          const filePath = resolve(baseDir, srcAttr)
          try {
            node._rendered = await readFile(filePath, 'utf8')
          } catch (e) {
            console.warn(`[Board] <include src="${srcAttr}"> read failed: ${e.message}`)
            node._rendered = `[include error: ${srcAttr}]`
          }
        }
      }
      // Recurse into children
      if (node.children) await this._resolveIncludesInNodes(node.children, baseDir, state)
    }
  }

  // --- Hook trigger ---

  async _triggerHook(event, payload) {
    const fns = this._handlers[event] ?? []
    for (const fn of fns) {
      try {
        await fn(payload)
      } catch (e) {
        console.error(`[Board] on('${event}') failed:`, e)
        throw e
      }
    }
  }

  async _emit(event, payload) {
    await this._triggerHook('emit:' + event, payload)
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
      memory: this._ctx.getMemory(),
    }
  }
}

// --- Utilities ---

/**
 * Extract top-level let/const/function/async function declaration names from script source
 */
function extractTopLevelNames(source) {
  const names = new Set()

  // Simple identifier(s): let x, const x, var x
  // Also handles multi-declaration: let a = 1, b = 2  →  ['a', 'b']
  for (const m of source.matchAll(/^(?:let|const|var)\s+(.+)/gm)) {
    // Split on commas that are not inside brackets/parens/braces to handle
    // multi-declaration (e.g. let a = 1, b = 2). We do a simple scan:
    // split at commas at depth-0.
    const decls = splitTopLevelCommas(m[1])
    for (const decl of decls) {
      const trimmed = decl.trim()
      // Skip destructuring — handled by the passes below
      if (trimmed.startsWith('{') || trimmed.startsWith('[')) continue
      // Grab identifier before any '=' or end-of-string
      const nameMatch = trimmed.match(/^(\w+)/)
      if (nameMatch) names.add(nameMatch[1])
    }
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

/**
 * Split a string on commas that are at the top-level (not inside brackets).
 * Used to parse multi-variable declarations like `a = 1, b = fn(x, y), c`.
 */
function splitTopLevelCommas(str) {
  const parts = []
  let depth = 0
  let start = 0
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    else if (ch === ',' && depth === 0) {
      parts.push(str.slice(start, i))
      start = i + 1
    }
  }
  parts.push(str.slice(start))
  return parts
}
