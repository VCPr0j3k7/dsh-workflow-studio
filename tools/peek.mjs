/**
 * 从 app.asar 里抠出某个官方包的 client.js / index.js 并做一次正则扫描。
 * 用法：node tools/peek.mjs <包名> <lib 内文件名> <正则>
 */
import { readFileSync } from 'node:fs'

import { asarPath } from './paths.mjs'

const ASAR = asarPath()
const [, , pkg, file, pattern] = process.argv

function readAsar(asarPath) {
  const buf = readFileSync(asarPath)
  const jsonSize = buf.readUInt32LE(12)
  const headerSize = buf.readUInt32LE(4)
  const json = JSON.parse(buf.toString('utf8', 16, 16 + jsonSize))
  const base = 8 + headerSize
  const node = (p) => {
    let cur = json
    for (const part of String(p).split('/').filter(Boolean)) {
      if (cur.files === undefined) return undefined
      cur = cur.files[part]
      if (cur === undefined) return undefined
    }
    return cur
  }
  return {
    text(p) {
      const n = node(p)
      if (!n || n.files !== undefined || n.offset === undefined) return null
      const start = base + Number(n.offset)
      return buf.subarray(start, start + Number(n.size)).toString('utf8')
    },
  }
}

const asar = readAsar(ASAR)
const path = `dsh/node_modules/@deepseek-ai/${pkg}/lib/${file}`
const text = asar.text(path)
if (text === null) {
  console.log(`(读不到 ${path})`)
  process.exit(1)
}
const clean = text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\0/g, '')
const re = new RegExp(pattern, 'g')
const lines = clean.split('\n')
let hits = 0
lines.forEach((line, index) => {
  if (re.test(line)) {
    hits += 1
    if (hits <= 40) console.log(`${String(index + 1)}: ${line.trim().slice(0, 190)}`)
  }
  re.lastIndex = 0
})
console.log(`--- 共 ${String(hits)} 处命中（文件 ${String(lines.length)} 行）---`)
