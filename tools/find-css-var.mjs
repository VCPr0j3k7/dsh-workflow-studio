/**
 * 在 app.asar 里做一次字节级搜索，找出某个 CSS 自定义属性**在哪里被定义**（带冒号的那次）。
 *
 * 为什么不用 grep 逐包翻：@deepseek-ai 下有几百个包，逐个 cat 又慢又容易漏。
 * 直接对 121MB 的 asar 做 Buffer.indexOf 扫一遍，所有出现位置和上下文一次拿全。
 */
import { readFileSync } from 'node:fs'

import { asarPath } from './paths.mjs'

const ASAR = asarPath()
const NEEDLES = ['--dsh-composer-dock-inset', '--dsh-composer-side-clearance', '--dsh-composer-card-max-width']

const buf = readFileSync(ASAR)

for (const needle of NEEDLES) {
  const bytes = Buffer.from(needle, 'utf8')
  const offsets = []
  let at = buf.indexOf(bytes)
  while (at >= 0) {
    offsets.push(at)
    at = buf.indexOf(bytes, at + 1)
  }
  // 找「定义」而不是「引用」：后面紧跟可选空白再跟冒号
  const definitions = offsets.filter((offset) => {
    const tail = buf.subarray(offset + bytes.length, offset + bytes.length + 4).toString('latin1')
    return /^\s*:/.test(tail)
  })
  console.log(`${needle}`)
  console.log(`  出现 ${String(offsets.length)} 次，其中**定义** ${String(definitions.length)} 次`)
  for (const offset of definitions.slice(0, 3)) {
    const context = buf.subarray(Math.max(0, offset - 90), offset + 90).toString('utf8').replace(/[\r\n]+/g, ' ')
    console.log(`    …${context}…`)
  }
  console.log('')
}
