/**
 * @promptu/runtime — TypeScript type definitions
 */

// ─── HistoryEntry ─────────────────────────────────────────────────────────────

/**
 * A single conversation history entry.
 */
export interface HistoryEntry {
  role: string
  content: string
  priority: 'high' | 'normal' | 'low'
  timestamp: number
}

// ─── ToolRegistry ─────────────────────────────────────────────────────────────

/**
 * A tool entry as declared in `<config> tools:` YAML.
 * Internal fields (`group`, `handler`, `_handler`) are stripped when
 * producing LLM-facing schemas.
 */
export interface ToolConfig {
  name: string
  description?: string
  group?: string | string[]
  [key: string]: unknown
}

/**
 * A tool schema as exposed to the LLM (internal fields stripped).
 */
export type ToolSchema = Omit<ToolConfig, 'group' | 'handler' | '_handler'>

/**
 * Manages a collection of tools declared in `<config>` and provides
 * filtered views via `byGroup()` / `byName()` / `all()`.
 *
 * Internal fields (`group`, `handler`, `_handler`) are stripped from all
 * returned schemas so they are safe to pass directly to an LLM.
 */
export declare class ToolRegistry {
  /**
   * @param toolConfigs - Raw tools array from parsed `<config>` block
   */
  constructor(toolConfigs?: ToolConfig[] | null)

  /**
   * Return all tools (public schema only — internal fields stripped).
   */
  all(): ToolSchema[]

  /**
   * Return tools belonging to any of the given groups (union semantics).
   *
   * A tool belongs to a group if its `group` field (string or string[])
   * includes any of the requested group names.
   *
   * @param groups - One or more group names to match
   */
  byGroup(...groups: string[]): ToolSchema[]

  /**
   * Return tools with the given names.
   *
   * @param names - One or more tool names to look up
   */
  byName(...names: string[]): ToolSchema[]

  /**
   * Strip internal fields from a tool config, producing the LLM-facing schema.
   */
  toSchema(tool: ToolConfig): ToolSchema
}

// ─── ContextManager ───────────────────────────────────────────────────────────

export declare class ContextManager {
  /** Route data to the current turn only (auto-discarded after render). */
  turn(data: unknown, opts?: { label?: string }): void

  /**
   * Append an entry to the conversation history.
   * `opts.priority` controls eviction order for `trimHistory()`:
   * `'low'` items are removed first.
   */
  history(data: unknown, opts?: { role?: string; priority?: 'high' | 'normal' | 'low' }): void

  /**
   * Store a value for the session lifetime.
   * Accepts either a key/value pair or a bulk-write object.
   * Read back with `getSession(key)`.
   */
  session(key: string, value: unknown): void
  session(entries: Record<string, unknown>): void

  /** Explicitly discard data (no-op — documents intent). */
  drop(data: unknown): void

  /** Read a session-stored value by key; omit key to get a full shallow copy. */
  getSession(key?: string): unknown

  /** Return a snapshot of the current-turn data array. */
  getTurnData(): unknown[]

  /**
   * Return the conversation history, optionally limited to the most recent `limit` entries.
   */
  getHistory(limit?: number): HistoryEntry[]

  /** Set or delete a runtime memory entry (pass null/undefined to delete the key). */
  memory(key: string, value: unknown): void

  /** Read a runtime memory entry; omit key to get a full shallow copy of all entries. */
  getMemory(key?: string): unknown

  /**
   * Discard all current-turn data.
   * Called automatically by the Runtime after each render cycle.
   */
  flushTurn(): void

  /**
   * Trim the history to the most recent `maxItems` entries.
   * `'low'` priority items are evicted first; within the same priority,
   * older entries (lower `timestamp`) are removed first.
   */
  trimHistory(maxItems: number): void
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export declare function renderTemplate(
  template: unknown,
  state: Record<string, unknown>,
  ctx: ContextManager,
): unknown

// ─── PromptuRuntime ───────────────────────────────────────────────────────────

export interface PromptuRuntimeOptions {
  /**
   * Watch the `.board` file (and included files) for changes and hot-reload.
   * @default true
   */
  watch?: boolean
}

export interface RuntimeContext {
  /** Conversation history entries */
  history: HistoryEntry[]
  /** Session-scoped key-value store (full shallow copy) */
  session: Record<string, unknown>
  /** Current turn data snapshot (discarded after each render) */
  turn: unknown[]
  /** Runtime memory entries */
  memory: Record<string, unknown>
}

/**
 * Low-level reactive template engine for `.board` files.
 *
 * Prefer the higher-level `@board/core` `createBoard()` / `Board` API unless
 * you need direct access to the runtime internals.
 *
 * Lifecycle:
 * ```
 * const rt = new PromptuRuntime('./main.board')
 * await rt.start()          // load file, exec <script>, fire 'mount'
 * // ... use rt._triggerHook / rt._render for each turn ...
 * await rt.stop()           // fire 'destroy', stop file watcher
 * ```
 */
export declare class PromptuRuntime {
  /**
   * @param entryPath - Path to the `.board` entry file
   * @param opts      - Optional configuration
   */
  constructor(entryPath: string, opts?: PromptuRuntimeOptions)

  /**
   * Load the `.board` file, execute its `<script>`, optionally start the file
   * watcher, and fire the `on('mount')` hook.
   *
   * Must be called before any other method.
   */
  start(): Promise<void>

  /**
   * Stop the file watcher and fire the `on('destroy')` hook.
   */
  stop(): Promise<void>

  /**
   * Return a shallow copy of the current reactive state (debug).
   */
  getState(): Record<string, unknown>

  /**
   * Return a snapshot of history, session, turn data, and memory (debug).
   */
  getContext(): RuntimeContext
}
