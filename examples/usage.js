/**
 * Board SDK — 使用示例
 *
 * 输入格式、输出格式由使用方在 .board 文件里定义。
 * Board 不预设任何 schema。
 */

import { createBoard } from '@board/core'

const board = await createBoard('./assistant.board')

// 传入任意结构的输入
// .board 里的 on('update') 钩子负责处理
const output = await board.update({
  type: 'tool_response',
  name: 'web_search',
  result: { items: ['...'] },
})

// output 由 .board 的 <template> 决定
// 可以是任意结构，使用方自己定义
console.log(output)

await board.destroy()
