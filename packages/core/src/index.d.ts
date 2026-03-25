/**
 * @board/core — TypeScript type definitions
 */

// ─── Tool Schema ──────────────────────────────────────────────────────────────

/**
 * A tool schema as exposed to the LLM (internal fields like `group` stripped).
 */
export interface ToolSchema {
  name: string
  description?: string
  [key: string]: unknown
}

/**
 * A tool entry as declared in `<config> tools:` section.
 * The `group` field is used for filtering and is stripped from LLM-facing schemas.
 */
export interface ToolConfig extends ToolSchema {
  group?: string | string[]
}

// ─── Script DSL Context (APIs available inside `.board` `<script>` blocks) ───

/**
 * APIs injected into `.board` `<script>` execution context.
 *
 * These are available as free variables in the script — you do **not**
 * import or declare them; Board injects them automatically.
 *
 * @example
 * ```board
 * <script>
 * let tools = []
 * on('update', (input) => {
 *   tools = toolsByGroup('coding')
 *   memory('lastInput', input)
 * })
 * </script>
 * ```
 */
export interface BoardScriptAPI {
  /** Register a lifecycle/event handler. */
  on(event: 'mount' | 'update' | 'destroy' | `emit:${string}`, fn: (payload?: unknown) => void): void

  /** Emit a named event (handled by external `board.on()` listeners). */
  emit(event: string, payload?: unknown): void

  /**
   * Read a session-stored value by key.
   *
   * Use `inject(key)` to read a value that was previously written with
   * `session(key, value)` or `session({ key: value })`.
   *
   * @param key - Session key to read
   */
  inject(key: string): unknown

  /** Append data to the current turn buffer (cleared each render). */
  turn(data: unknown): void

  /** Push an entry into history. */
  history(data: unknown, opts?: { role?: string; priority?: 'high' | 'normal' | 'low' }): void

  /**
   * Write a session-scoped key-value entry (persists for the lifetime of the session).
   *
   * - `session(key, value)` — set a single key
   * - `session({ key: value, ... })` — bulk-set multiple keys at once
   *
   * To read a session value back, use `inject(key)`.
   */
  session(key: string, value: unknown): void
  session(entries: Record<string, unknown>): void

  /** Drop / remove data from context. */
  drop(data: unknown): void

  // ── ToolRegistry APIs ──────────────────────────────────────────────────────

  /**
   * Return tools matching any of the given group names.
   * Internal fields (`group`, `handler`, etc.) are stripped from results.
   *
   * @param groups - One or more group names to match
   */
  toolsByGroup(...groups: string[]): ToolSchema[]

  /**
   * Return tools with the given names.
   * Internal fields are stripped from results.
   *
   * @param names - One or more tool names to look up
   */
  toolsByName(...names: string[]): ToolSchema[]

  /**
   * Return all tools declared in `<config>`.
   * Internal fields (`group`, `handler`, etc.) are stripped.
   */
  allTools(): ToolSchema[]

  // ── Runtime Memory APIs ────────────────────────────────────────────────────

  /**
   * Set or delete a runtime memory entry.
   * Unlike `session()`, runtime memory is managed manually and never
   * cleared automatically between turns.
   *
   * Pass `null` or `undefined` as `value` to delete the key.
   *
   * @param key   - Memory key
   * @param value - Value to store (`null`/`undefined` removes the key)
   *
   * @example
   * ```ts
   * memory('screenshot', 'img_001')  // set
   * memory('screenshot', null)        // delete
   * ```
   */
  memory(key: string, value: unknown): void

  /**
   * Read a runtime memory entry.
   *
   * - Pass `key` to get a single value (returns `undefined` if not set).
   * - Omit `key` to get a shallow copy of all entries.
   *
   * @param key - Optional memory key
   */
  getMemory(key?: string): unknown
}

// ─── Options ──────────────────────────────────────────────────────────────────

export interface CreateBoardOptions {
  /**
   * Watch the `.board` file for changes and hot-reload automatically.
   * @default true
   */
  watch?: boolean
}

// ─── Context ──────────────────────────────────────────────────────────────────

export interface BoardContext {
  /** Conversation history entries */
  history: unknown[]
  /** Session-scoped key-value store */
  session: Record<string, unknown>
  /** Current turn data (discarded after each render) */
  turn: unknown[]
}

// ─── Board ────────────────────────────────────────────────────────────────────

export declare class Board {
  /**
   * Core method: pass any input, get the rendered template output back.
   *
   * Triggers the `on('update', fn)` hook in the `.board` script,
   * re-renders the `<template>`, and returns the result.
   *
   * @param input - Any structure; your `.board` script handles it via `on('update', ...)`
   * @returns Rendered template output (shape defined by your `<template>`)
   */
  update(input: unknown): Promise<unknown>

  /**
   * Switch to a different `.board` file at runtime.
   * Fires the `on('mount', fn)` hook after loading.
   *
   * @param boardPath - Path to the new `.board` file
   */
  load(boardPath: string): Promise<void>

  /**
   * Return a shallow copy of the current reactive state (for debugging).
   */
  getState(): Record<string, unknown>

  /**
   * Return the current context: history, session, and turn data (for debugging).
   */
  getContext(): BoardContext

  /**
   * Trim conversation history to at most `maxItems` entries.
   * Low-priority items (added with `priority: 'low'`) are evicted first;
   * among equal-priority items, oldest entries are removed first.
   *
   * @param maxItems - Maximum number of history entries to keep
   */
  trimHistory(maxItems: number): void

  /**
   * Fire a named event from outside the board.
   * The `.board` script listens via `on('emit:<name>', fn)`.
   *
   * @param event   - Event name (without the `'emit:'` prefix)
   * @param payload - Optional payload passed to listeners
   */
  emit(event: string, payload?: unknown): Promise<void>

  /**
   * Listen to a runtime or emit event from outside the board.
   *
   * Common events:
   * - `'mount'`        — fired after `createBoard()` or `load()`
   * - `'update'`       — fired on each `board.update()` call
   * - `'destroy'`      — fired on `board.destroy()`
   * - `'emit:<name>'`  — fired when the `.board` script calls `emit('name', payload)`
   *
   * @param event - Event name
   * @param fn    - Listener function
   */
  on(event: string, fn: (payload?: unknown) => void): void

  /**
   * Remove an external listener.
   * - Pass `fn` to remove only that specific function.
   * - Omit `fn` to remove **all** listeners for the event.
   *
   * @param event - Event name
   * @param fn    - Listener to remove (optional)
   */
  off(event: string, fn?: (payload?: unknown) => void): void

  /**
   * Stop the runtime, release file watchers, and clean up resources.
   */
  destroy(): Promise<void>
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create a Board instance from a `.board` file.
 *
 * @param boardPath - Path to the `.board` file
 * @param opts      - Optional configuration
 * @returns A ready-to-use `Board` instance
 *
 * @example
 * ```ts
 * import { createBoard } from '@board/core'
 *
 * const board = await createBoard('./main.board')
 * const output = await board.update({ message: 'Hello', history: [] })
 * ```
 */
export declare function createBoard(
  boardPath: string,
  opts?: CreateBoardOptions,
): Promise<Board>
