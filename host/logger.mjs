/**
 * 日志出口。
 *
 * 两路同时写：
 *   - `ctx.logger.info`：进宿主日志，排障时用它；
 *   - 内存环形缓冲：客户端半边通过 `GET /logs` 拉取，界面上的「诊断」一栏用它。
 *
 * 宿主 stdio 里没有插件日志，所以内存这一路不是可选项 —— 没有它，「插件没生效」
 * 就只能靠猜。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_LINES = 2000

let lines = []
let sink = null
let configured = false

/** 配置落盘文件。传入 null 表示只留内存。 */
export function configureLogger({ logFile = null } = {}) {
  if (typeof logFile === 'string' && logFile !== '') {
    try {
      mkdirSync(dirname(logFile), { recursive: true })
      sink = logFile
    } catch {
      sink = null
    }
  }
  configured = true
}

export function loggerReady() {
  return configured
}

/** 追加一行。任何写失败都被吞掉：日志不能成为故障源。 */
export function appendLine(message, { source = 'workflow-studio', level = 'info' } = {}) {
  const entry = { time: Date.now(), level, source, message: String(message) }
  lines.push(entry)
  if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES)
  if (sink !== null) {
    try {
      appendFileSync(sink, `${new Date(entry.time).toISOString()} [${level}] ${entry.message}\n`, 'utf8')
    } catch {
      // 忽略
    }
  }
  return entry
}

/** 读取最近的日志（倒序或正序）。 */
export function readLines({ limit = 400, since = 0 } = {}) {
  const from = Number.isFinite(since) ? Math.max(0, Math.trunc(since)) : 0
  return lines.slice(from).slice(-Math.max(1, Math.trunc(limit)))
}

export function lineCount() {
  return lines.length
}
