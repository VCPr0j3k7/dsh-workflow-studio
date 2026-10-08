/**
 * 把 asar 里某个文件的一段行区间打出来（排障用）。
 * 用法：node tools/slice.mjs <包名> <lib 内文件名> <起行> <止行>
 */
import { readFileSync } from 'node:fs'

import { asarPath } from './paths.mjs'

const ASAR = asarPath()
const [, , pkg, file, from, to] = process.argv

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

const text = readAsar(ASAR).text(`dsh/node_modules/@deepseek-ai/${pkg}/lib/${file}`)
if (text === null) {
  console.log('(读不到)')
  process.exit(1)
}
const clean = text.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '').replace(/\0/g, '')
const lines = clean.split('\n')
const start = Number(from)
const end = Number(to)
for (let index = start; index <= end && index <= lines.length; index += 1) {
  console.log(`${String(index)}: ${lines[index - 1]}`)
}
