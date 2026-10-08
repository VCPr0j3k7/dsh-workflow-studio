/**
 * 列出会话日志里每一次命令执行：命令名、参数、结果。
 * 用法：node tools/inspect-commands.mjs [日志路径]
 */
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const FILE = process.argv[2]
if (FILE === undefined || FILE === '') {
  console.error(
    '用法：node tools/inspect-commands.mjs <session.v4.jsonl.zstd 的路径>\n' +
      '  会话日志在 <DSH_HOME>/sessions/<工作目录>/<session id>/session.v4.jsonl.zstd',
  )
  process.exit(2)
}

const raw = readFileSync(FILE)
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]
const offsets = []
for (let i = 0; i + 4 <= raw.length; i += 1) {
  if (raw[i] === MAGIC[0] && raw[i + 1] === MAGIC[1] && raw[i + 2] === MAGIC[2] && raw[i + 3] === MAGIC[3]) offsets.push(i)
}

const parts = []
for (let i = 0; i < offsets.length; i += 1) {
  const end = i + 1 < offsets.length ? offsets[i + 1] : raw.length
  try {
    parts.push(zstdDecompressSync(raw.subarray(offsets[i], end)))
  } catch {
    // 压缩数据里撞上魔数的错帧，跳过
  }
}

const lines = Buffer.concat(parts).toString('utf8').split('\n').filter(Boolean)
console.log(`共 ${String(lines.length)} 条事件\n`)

console.log('=== 每一次命令执行 ===')
for (const line of lines) {
  if (!line.includes('"command/run"') && !line.includes('"command/done"')) continue
  try {
    const event = JSON.parse(line)
    const d = event.data ?? {}
    if (event.type === 'command/run') {
      console.log(`  seq=${String(event.seq)}  ▶ /${String(d.name)}  参数=「${String(d.args ?? '')}」`)
    } else {
      const text = String(d.result?.text ?? d.result?.kind ?? '').replace(/\s+/g, ' ').slice(0, 70)
      console.log(`  seq=${String(event.seq)}  ◀ ${String(d.result?.kind)}  ${text}`)
    }
  } catch {
    // 忽略
  }
}

console.log('\n=== 每个 user/message 的前 40 字（标出以 / 开头的）===')
const users = lines.filter((l) => l.includes('"user/message"'))
for (const line of users) {
  try {
    const event = JSON.parse(line)
    const text = String((event.data?.content ?? []).find((b) => b.type === 'text')?.text ?? '')
    const preview = text.replace(/\s+/g, ' ').slice(0, 40)
    if (preview.startsWith('/')) console.log(`  seq=${String(event.seq)}  ⚠ 未执行： 「${preview}」`)
  } catch {
    // 忽略
  }
}
console.log('  （只有上面这些以 / 开头的才是「本该是命令、却被当普通消息发出去」的）')
