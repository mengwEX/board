/**
 * @board/core — TypeScript type definitions
 */

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
