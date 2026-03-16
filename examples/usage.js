/**
 * Board SDK — 使用示例
 *
 * Board 只负责：LLM 回复 → 工具执行 → 下一次请求拼接
 * LLM 调用、HTTP 连接、对话循环 → 调用方自己做
 */

import { createBoard } from '@board/core'

// ─── 1. 初始化 ────────────────────────────────────────────────────────────────

const board = await createBoard('./assistant.board')

// ─── 2. 调用方自己的 LLM 请求函数（board 不管这部分）────────────────────────

async function callLLM(request) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    }),
  })
  const data = await res.json()
  return data.choices[0].message  // { role, content, tool_calls }
}

// ─── 3. 对话循环（调用方写，board 只是其中一环）──────────────────────────────

async function chat(userInput) {
  // 用户消息进 board → 拿到第一次请求体
  let request = await board.update({ role: 'user', content: userInput })

  while (true) {
    // 调用方自己发给 LLM
    const llmResponse = await callLLM(request)

    // LLM 回复进 board → board 执行工具、触发钩子、拼下一次请求体
    request = await board.update(llmResponse)

    // 如果 LLM 没有 tool_calls，说明这轮结束了
    if (!llmResponse.tool_calls || llmResponse.tool_calls.length === 0) {
      console.log('Assistant:', llmResponse.content)
      break
    }
  }
}

// ─── 运行 ─────────────────────────────────────────────────────────────────────

await chat('帮我搜索一下最新的 AI 框架')

await board.destroy()
