/**
 * Promptu OpenClaw Adapter
 *
 * 把 Promptu Runtime 接入 OpenClaw，接管请求组装层。
 *
 * 接入方式：
 *   1. registerContextEngine — 控制 messages 组装（assemble）
 *   2. before_prompt_build hook — 控制 system prompt
 *   3. registerTool — 暴露 promptu_load / promptu_status 给 AI
 *
 * AI 写完 .ptu 文件后，下一轮请求就按该文件逻辑组装。
 */

import { resolve, join } from 'path'
import { existsSync } from 'fs'

// @promptu/runtime 通过 require 加载（避免 ESM/CJS 冲突）
let PromptuRuntime: any
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  PromptuRuntime = require('@promptu/runtime').PromptuRuntime
} catch {
  PromptuRuntime = null
}

// ─── Plugin 状态 ──────────────────────────────────────────────────────────────

let runtime: any = null
let runtimeReady = false
let projectPath = ''
let entryFile = 'main.ptu'

// ─── Plugin 入口 ──────────────────────────────────────────────────────────────

export default function register(api: any) {
  const cfg = api.config?.plugins?.entries?.promptu?.config ?? {}
  projectPath = cfg.projectPath ? resolve(cfg.projectPath.replace('~', process.env.HOME ?? '')) : ''
  entryFile = cfg.entry ?? 'main.ptu'

  if (!projectPath) {
    api.logger?.warn('[Promptu] projectPath not configured, plugin disabled')
    return
  }

  const entryPath = join(projectPath, entryFile)

  // ── 1. 启动 Runtime ─────────────────────────────────────────────────────────
  if (PromptuRuntime && existsSync(entryPath)) {
    runtime = new PromptuRuntime(entryPath, { watch: true })
    runtime.start().then(() => {
      runtimeReady = true
      api.logger?.info(`[Promptu] Runtime started: ${entryPath}`)
    }).catch((e: Error) => {
      api.logger?.error(`[Promptu] Runtime start failed: ${e.message}`)
    })
  } else {
    api.logger?.warn(`[Promptu] Entry file not found: ${entryPath}`)
  }

  // ── 2. Context Engine — 接管 messages 组装 ──────────────────────────────────
  api.registerContextEngine('promptu', () => ({
    info: {
      id: 'promptu',
      name: 'Promptu Context Engine',
      ownsCompaction: false,
    },

    /**
     * ingest: 接收新消息/工具结果，交给 Promptu Runtime 处理
     */
    async ingest(event: any) {
      if (!runtimeReady || !runtime) return { ingested: false }

      try {
        if (event.type === 'user_message') {
          // 用户消息：触发 on('message')，更新 currentInput
          await runtime.processUserMessage(event.content ?? '')
        } else if (event.type === 'tool_result') {
          // 工具结果：触发 on('tool_response')，AI 决定分流
          await runtime.process({
            tool_calls: [{
              name: event.toolName,
              arguments: event.args ?? {},
              _result: event.result,
            }]
          })
        } else if (event.type === 'assistant_message') {
          // LLM 文本回复：触发 on('llm_response')
          await runtime.process({
            content: event.content ?? '',
            tool_calls: [],
          })
        }
        return { ingested: true }
      } catch (e: any) {
        api.logger?.error(`[Promptu] ingest error: ${e.message}`)
        return { ingested: false }
      }
    },

    /**
     * assemble: 组装下一轮请求的 messages
     * 返回值会被 OpenClaw 用作这轮请求的 messages
     */
    async assemble(ctx: any) {
      if (!runtimeReady || !runtime) {
        // Promptu 未就绪，降级到默认行为
        return { messages: ctx.messages, estimatedTokens: 0 }
      }

      try {
        const rendered = runtime._render()

        // 把 Promptu 渲染出的 messages 替换掉默认的
        const assembledMessages = rendered.messages ?? ctx.messages

        return {
          messages: assembledMessages,
          estimatedTokens: estimateTokens(assembledMessages),
          // system prompt 通过 before_prompt_build hook 注入
          _promptuSystem: rendered.system,
          _promptuTools: rendered.tools,
        }
      } catch (e: any) {
        api.logger?.error(`[Promptu] assemble error: ${e.message}`)
        return { messages: ctx.messages, estimatedTokens: 0 }
      }
    },

    /**
     * compact: 历史压缩（由 Promptu 的 history priority 机制控制）
     */
    async compact() {
      if (runtime) {
        runtime._ctx?.trimHistory(50)
      }
      return { ok: true, compacted: false }
    },
  }))

  // ── 3. before_prompt_build — 注入 system prompt ──────────────────────────────
  api.on('before_prompt_build', (event: any, ctx: any) => {
    if (!runtimeReady || !runtime) return {}

    try {
      const rendered = runtime._render()
      if (rendered.system) {
        return { systemPrompt: rendered.system }
      }
    } catch {}

    return {}
  })

  // ── 4. 工具：AI 可以加载/重载 .ptu 文件 ────────────────────────────────────
  api.registerTool({
    name: 'promptu_load',
    description: 'Load or reload a .ptu component file into the Promptu Runtime. Call this after creating or modifying a .ptu file to immediately activate it.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute or relative path to the .ptu file to load'
        }
      },
      required: ['path']
    },
    handler: async ({ path: filePath }: { path: string }) => {
      if (!runtime) return { ok: false, error: 'Promptu Runtime not started' }

      const absPath = filePath.startsWith('/')
        ? filePath
        : join(projectPath, filePath)

      if (!existsSync(absPath)) {
        return { ok: false, error: `File not found: ${absPath}` }
      }

      try {
        await runtime._loadFile(absPath)
        return { ok: true, loaded: absPath, message: 'Component loaded successfully. Active next turn.' }
      } catch (e: any) {
        return { ok: false, error: e.message }
      }
    }
  })

  api.registerTool({
    name: 'promptu_status',
    description: 'Get the current status of the Promptu Runtime: loaded file, reactive state, context summary.',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      if (!runtime) return { ready: false, reason: 'Runtime not started' }

      return {
        ready: runtimeReady,
        entry: join(projectPath, entryFile),
        state: runtime.getState(),
        context: runtime.getContext(),
      }
    }
  })

  // ── 5. 注册 /promptu 命令 ─────────────────────────────────────────────────
  api.registerCommand({
    name: 'promptu',
    description: 'Show Promptu Runtime status',
    handler: () => {
      if (!runtimeReady) return { text: '⚠️ Promptu Runtime not ready' }
      const state = runtime.getState()
      const ctx = runtime.getContext()
      return {
        text: [
          '**Promptu Runtime** ✅',
          `Entry: \`${join(projectPath, entryFile)}\``,
          `State keys: ${Object.keys(state).join(', ')}`,
          `History: ${ctx.history.length} messages`,
          `Session keys: ${Object.keys(ctx.session).join(', ') || 'none'}`,
        ].join('\n')
      }
    }
  })

  api.logger?.info('[Promptu] Plugin registered')
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

function estimateTokens(messages: any[]): number {
  return messages.reduce((sum, m) => {
    return sum + Math.ceil((m.content?.length ?? 0) / 4)
  }, 0)
}
