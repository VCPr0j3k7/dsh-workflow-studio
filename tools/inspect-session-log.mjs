/**
 * 从压缩的会话日志里找出「命令到底有没有执行」的直接证据。
 *
 * ## 为什么必须看日志
 *
 * `/workflow` 到底是
 *   (a) 走了 `ctx.commands.execute`（日志里会有一对 `command/run` + `command/done`），还是
 *   (b) 被当成普通用户消息发了出去（只有 `user/message`），
 * 这两者在日志里截然不同。前面几轮都在猜 UI 行为，其实证据一直躺在这儿。
 *
 * ## 为什么不能直接 zstdDecompressSync 整个文件
 *
 * 这个 `.zstd` 是**多帧**拼接的（每次刷盘追加一帧）。三种做法里只有第三种对：
 *   - `zstdDecompressSync(整个文件)` → 只解第一帧，得到 196 字节，看起来像「日志几乎是空的」
 *   - `createZstdDecompress()` 喂整块 → 同样只解第一帧
 *   - **扫帧魔数、逐帧解** → 全部拿到（DSH 自己也是这么做的，
 *     见 dsh-session-persistence-jsonl 的 zstd-frame-decoder）
 *
 * 那个 196 字节的假象很坑：它长得像「这个会话没记什么」，实际文件有 2.7MB。
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const FILE = process.argv[2]
if (FILE === undefined || FILE === '') {
  console.error(
    '用法：node tools/inspect-session-log.mjs <session.v4.jsonl.zstd 的路径>\n' +
      '  会话日志在 <DSH_HOME>/sessions/<工作目录>/<session id>/session.v4.jsonl.zstd\n' +
      '  直接给路径而不是写死一个默认值 —— 每个会话的路径都不一样。',
  )
  process.exit(2)
}

const raw = readFileSync(FILE)
/** Zstandard 帧魔数 `28 B5 2F FD`。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

const offsets = []
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) offsets.push(i)
}

const parts = []
let decoded = 0
let skipped = 0
for (let i = 0; i < offsets.length; i += 1) {
  const start = offsets[i]
  const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
  try {
    parts.push(zstdDecompressSync(raw.subarray(start, end)))
    decoded += 1
  } catch {
    // 压缩数据内部撞上魔数会切出错帧 —— 跳过即可，不影响其余帧
    skipped += 1
  }
}

console.log(`压缩 ${String(raw.length)} 字节 · 扫到 ${String(offsets.length)} 个帧边界 · 解开 ${String(decoded)} 帧（跳过 ${String(skipped)}）`)

const text = Buffer.concat(parts).toString('utf8')
const lines = text.split('\n').filter(Boolean)
console.log(`得到 ${String(lines.length)} 条事件\n`)

const counts = new Map()
for (const line of lines) {
  try {
    const type = JSON.parse(line).type
    counts.set(type, (counts.get(type) ?? 0) + 1)
  } catch {
    // 忽略
  }
}

console.log('=== 命令相关事件 ===')
const commandTypes = [...counts].filter(([type]) => type.includes('command'))
if (commandTypes.length === 0) console.log('  （一条都没有 —— 命令从未被执行）')
for (const [type, n] of commandTypes) console.log(`  ${type}  ×${String(n)}`)

console.log('\n=== 用户消息（最后 6 条）===')
const users = lines.filter((line) => line.includes('"user/message"'))
for (const line of users.slice(-6)) {
  try {
    const event = JSON.parse(line)
    const blocks = event.data?.content ?? []
    const textBlock = blocks.find((b) => b.type === 'text')
    const preview = String(textBlock?.text ?? '').replace(/\s+/g, ' ').slice(0, 88)
    console.log(`  seq=${String(event.seq)}  「${preview}」`)
  } catch {
    // 忽略
  }
}
