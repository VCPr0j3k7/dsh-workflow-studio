/**
 * 找出 client.js 里 CSS 模板字符串内部的反引号并删掉。
 *
 * 为什么需要这个脚本：CSS 整块是一个模板字符串，里面出现任何一个反引号都会提前
 * 结束字符串，让**整个文件**语法错误 —— 而报错位置指向的是被截断处之后的地方，
 * 不是真正写错的那一行。手工一个个找很容易漏（我第一次就漏了两处）。
 */
import { readFileSync, writeFileSync } from 'node:fs'

import { PLUGIN_ROOT } from './paths.mjs'

const FILE = `${PLUGIN_ROOT}/client.js`
const text = readFileSync(FILE, 'utf8')

const marker = 'const CSS = `'
const start = text.indexOf(marker)
if (start < 0) throw new Error('找不到 CSS 模板字符串起点')
const bodyStart = start + marker.length
// 结束标记：行首的 "`;"（CSS 块收尾那两行）
const end = text.indexOf('\n`;', bodyStart)
if (end < 0) throw new Error('找不到 CSS 模板字符串终点')

const css = text.slice(bodyStart, end)
const lines = css.split('\n')
const offending = lines
  .map((line, index) => ({ line, index }))
  .filter((item) => item.line.includes('`'))

console.log(`CSS 块：${String(lines.length)} 行，其中含反引号的 ${String(offending.length)} 行`)
for (const item of offending) console.log(`  ${String(item.index + 1)}: ${item.line.trim().slice(0, 90)}`)

if (offending.length === 0) {
  console.log('\n没有需要修的。')
  process.exit(0)
}

// 把反引号换成直角引号：既保留「这是个标识符」的语感，又不会截断字符串
const fixedCss = css.replace(/`/g, '「').replace(/「([^「」]*)」/g, '「$1」')
// 上面那步只是把成对的反引号统一成开引号，这里把「开引号」再配成对
const paired = []
let open = false
for (const ch of fixedCss) {
  if (ch === '「') {
    paired.push(open ? '」' : '「')
    open = !open
  } else {
    paired.push(ch)
  }
}
const rebuilt = text.slice(0, bodyStart) + paired.join('') + text.slice(end)
writeFileSync(FILE, rebuilt, 'utf8')
console.log(`\n已把 ${String(offending.length)} 行里的反引号替换成直角引号。`)
