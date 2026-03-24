/**
 * @board/runtime (internal) — TypeScript type definitions
 */

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
  /** Read a session-stored value by key (alias for getSession). */
  inject(key: string): unknown
  turn(data: unknown): void
  history(data: unknown, opts?: { role?: string; priority?: string }): void
  /** Set a single session key, or bulk-set via object. */
  session(key: string, value?: unknown): unknown
  session(entries: Record<string, unknown>): void
  drop(data: unknown): void

  /** Set or delete a runtime memory entry (pass null/undefined to delete). */
  memory(key: string, value: unknown): void

  /** Read a runtime memory entry; omit key to get a full shallow copy. */
  getMemory(key?: string): unknown

  flush(): void
}

// ─── Renderer ─────────────────────────────────────────────────────────────────

export declare function renderTemplate(
  template: unknown,
  state: Record<string, unknown>,
  ctx: ContextManager,
): unknown
