/**
 * @board/parser — TypeScript type definitions
 */

// ─── AST Node Types ───────────────────────────────────────────────────────────

/** A literal text segment. */
export interface TextNode {
  type: 'text'
  value: string
}

/** A `{{ expr }}` interpolation. */
export interface InterpolationNode {
  type: 'interpolation'
  expr: string
}

/** A static attribute value (e.g. `role="user"`). */
export interface StaticAttrValue {
  type: 'static'
  value: string
}

/** A dynamic attribute value (e.g. `role="{{ myVar }}`). */
export interface DynamicAttrValue {
  type: 'dynamic'
  expr: string
}

export type AttrValue = StaticAttrValue | DynamicAttrValue

/** An `<if cond="...">` conditional node. */
export interface IfNode {
  type: 'if'
  cond: AttrValue
  children: Node[]
}

/**
 * An `<each :items="expr" as="alias">` iteration node.
 *
 * - `items` — expression that evaluates to an array (use `:items="expr"` for dynamic)
 * - `as`    — loop variable alias (default: `"item"`)
 */
export interface EachNode {
  type: 'each'
  /** Array source expression. */
  items: AttrValue
  /** Loop variable alias. */
  as?: AttrValue
  children: Node[]
}

/** A `<include src="..." />` include node. */
export interface IncludeNode {
  type: 'include'
  /** Static or dynamic source path (`src="..."` or `:src="expr"`). */
  src: AttrValue
  /**
   * Optional conditional attribute (`:if="expr"`).
   * When present and the expression evaluates to falsy, the include is skipped.
   */
  if?: AttrValue
  /** Any additional attributes parsed from the tag. */
  [key: string]: string | AttrValue | undefined
}

/** A `<message>`, `<user>`, or `<assistant>` message node. */
export interface MessageNode {
  type: 'message'
  role: AttrValue
  children: Node[]
  /** Any additional attributes parsed from the tag. */
  [key: string]: string | AttrValue | Node[] | undefined
}

/** Any template AST node. */
export type Node =
  | TextNode
  | InterpolationNode
  | IfNode
  | EachNode
  | IncludeNode
  | MessageNode

/** A named top-level section inside a `<template>` block. */
export interface Section {
  /** The section tag name (e.g. `"system"`, `"user"`, `"assistant"`). */
  name: string
  /** Parsed child nodes. */
  nodes: Node[]
}

/** Parsed representation of a `<template>` block. */
export interface TemplateAST {
  /**
   * Top-level sections (populated when the template has named top-level tags).
   * Empty when the template has no top-level tags (see `rawNodes`).
   */
  sections: Section[]
  /**
   * Raw node list when there are no top-level section tags.
   * Only present when `sections` is empty.
   */
  rawNodes?: Node[]
}

// ─── Board AST ────────────────────────────────────────────────────────────────

/** The top-level AST returned by `parse()`. */
export interface BoardAST {
  /** Source filename (or `"<unknown>"` if not provided). */
  filename: string
  /** Parsed `<template>` block, or `null` if absent. */
  template: TemplateAST | null
  /** Raw `<script>` block source text, or `null` if absent. */
  script: string | null
  /** Parsed `<config>` block as a plain object (YAML), or `{}` if absent. */
  config: Record<string, unknown>
}

// ─── Errors ───────────────────────────────────────────────────────────────────

/** Thrown when `parse()` encounters a malformed `.board` file. */
export declare class ParseError extends Error {
  name: 'ParseError'
  /** The filename that triggered the error. */
  filename: string
  constructor(message: string, filename: string)
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Parse a `.board` file's source text into a `BoardAST`.
 *
 * @param source   Full `.board` file contents.
 * @param filename Optional filename used in error messages (default: `"<unknown>"`).
 * @returns        The parsed `BoardAST`.
 * @throws {ParseError} If the source contains unclosed or malformed blocks.
 *
 * @example
 * ```ts
 * import { parse } from '@board/parser'
 *
 * const ast = parse(`
 *   <template>
 *     <system>You are a helpful assistant.</system>
 *     <user>{{ input }}</user>
 *   </template>
 *   <config>
 *     model: gpt-4o
 *   </config>
 * `, 'my-agent.board')
 *
 * console.log(ast.template?.sections[0].name) // "system"
 * ```
 */
export declare function parse(source: string, filename?: string): BoardAST
