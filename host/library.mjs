/**
 * 工作流库：把「工作流」变成一份可复用、可版本化的用户资产。
 *
 * ## 为什么需要这一层
 *
 * 官方的 `workflow` 工具让**模型**现场写一段脚本；这适合一次性编排，但不适合
 * 「这个流程我每周都要跑一遍」。ZCode 的做法是把工作流沉淀成文件，再用
 * `/workflow` 把它们调起来 —— 本模块就是这一层。
 *
 * ## 文件格式
 *
 * `<DSH_HOME>/workflows/<name>.js`，YAML frontmatter + 脚本正文：
 *
 * ```js
 * ---
 * name: audit-docs
 * description: 审计 docs/ 下每个文件的准确性
 * whenToUse: 当需要批量核对文档时
 * phases:
 *   - title: 扫描
 *     detail: 列出待审计文件
 *   - title: 审计
 *     detail: 每个文件一个子智能体
 * ---
 * const files = args.files ?? []
 * const found = await pipeline(files, async (file) => agent(`审计 ${file}`, { label: file, phase: '审计' }))
 * return { total: files.length, found }
 * ```
 *
 * frontmatter 里除了官方 `WorkflowMeta` 的四个字段（name / description / whenToUse / phases），
 * 还支持本插件扩展的 `graph`（声明式结构，见 `host/script.mjs`）。
 *
 * ## 为什么自己写 frontmatter 解析器
 *
 * 插件以 `file:` 方式链进 profile，`node_modules` 里没有它自己的依赖树 —— 依赖 `yaml`
 * 在别的机器上会直接 MODULE_NOT_FOUND。这里实现的是 YAML 的一个**明确子集**
 * （标量、引号字符串、块标量、嵌套映射、映射列表），覆盖上面这种 frontmatter 的全部写法；
 * 需要表达更复杂的东西时用 `.json`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bundledWorkflowRoot, userWorkflowRoot } from './env.mjs'

/** 工作流名必须是安全的文件名词：小写字母/数字/短横线/下划线。 */
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

//#region frontmatter 解析（YAML 子集）

/** 去掉行尾注释，但引号内的 `#` 不算注释。 */
function stripComment(line) {
  let out = ''
  let quote = null
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index]
    if (quote !== null) {
      out += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      continue
    }
    if (ch === '#' && (index === 0 || /\s/.test(line[index - 1]))) break
    out += ch
  }
  return out
}

/** 把一段标量文本转成 JS 值。 */
function scalar(raw) {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text === 'true') return true
  if (text === 'false') return false
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?\d*\.\d+$/.test(text)) return Number(text)
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return text.slice(1, -1).replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map((part) => scalar(part))
  }
  return text
}

function isListItem(text) {
  return text === '-' || text.startsWith('- ')
}

/** 形如 `key: value` 或 `key:` 的行。 */
function splitKey(text) {
  const match = /^([^:\s][^:]*?):(\s[\s\S]*|)$/.exec(text)
  if (match === null) return null
  return { key: match[1].trim(), inline: match[2].trim() }
}

function parseMap(rows, start, indent) {
  const out = {}
  let index = start
  while (index < rows.length && rows[index].indent === indent && isListItem(rows[index].text) === false) {
    const split = splitKey(rows[index].text)
    if (split === null) {
      index += 1
      continue
    }
    const { key, inline } = split
    if (inline === '|' || inline === '>') {
      const parts = []
      let cursor = index + 1
      while (cursor < rows.length && rows[cursor].indent > indent) {
        const extra = rows[cursor].indent - (indent + 2)
        parts.push(`${extra > 0 ? ' '.repeat(extra) : ''}${rows[cursor].text}`)
        cursor += 1
      }
      out[key] = parts.join(inline === '|' ? '\n' : ' ')
      index = cursor
      continue
    }
    if (inline !== '') {
      out[key] = scalar(inline)
      index += 1
      continue
    }
    if (index + 1 < rows.length && rows[index + 1].indent > indent) {
      const [value, next] = parseNode(rows, index + 1, rows[index + 1].indent)
      out[key] = value
      index = next
      continue
    }
    out[key] = null
    index += 1
  }
  return [out, index]
}

function parseSeq(rows, start, indent) {
  const out = []
  let index = start
  while (index < rows.length && rows[index].indent === indent && isListItem(rows[index].text)) {
    const rest = rows[index].text === '-' ? '' : rows[index].text.slice(2)
    if (rest === '') {
      if (index + 1 < rows.length && rows[index + 1].indent > indent) {
        const [value, next] = parseNode(rows, index + 1, rows[index + 1].indent)
        out.push(value)
        index = next
      } else {
        out.push(null)
        index += 1
      }
      continue
    }
    if (splitKey(rest) !== null && /^[^:\s][^:]*?:(\s|$)/.test(rest)) {
      // `- title: 扫描` —— 把这一行改写成更深一层的映射首行，然后按映射解析
      rows[index] = { indent: indent + 2, text: rest }
      const [value, next] = parseMap(rows, index, indent + 2)
      out.push(value)
      index = next
      continue
    }
    out.push(scalar(rest))
    index += 1
  }
  return [out, index]
}

function parseNode(rows, start, indent) {
  if (start >= rows.length) return [null, start]
  if (rows[start].indent === indent && isListItem(rows[start].text)) return parseSeq(rows, start, indent)
  return parseMap(rows, start, indent)
}

/**
 * 解析 YAML 子集。
 * @param {string} text frontmatter 正文（不含两侧的 `---`）
 * @returns {Record<string, unknown>}
 */
export function parseMiniYaml(text) {
  const rows = []
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue
    const stripped = stripComment(rawLine)
    if (stripped.trim() === '') continue
    const indent = stripped.length - stripped.trimStart().length
    if (stripped.trimStart().startsWith('-') === false && stripped.includes('\t')) {
      // 制表符缩进在 YAML 里非法，这里明确报错而不是静默解析错
      throw new Error('frontmatter 不支持制表符缩进，请改用空格')
    }
    rows.push({ indent, text: stripped.trim() })
  }
  if (rows.length === 0) return {}
  const [value] = parseNode(rows, 0, rows[0].indent)
  return value ?? {}
}

/** 拆出 frontmatter 与正文。没有 frontmatter 时 meta 为 null。 */
export function splitFrontmatter(source) {
  const text = String(source).replace(/^\uFEFF/, '')
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (match === null) return { meta: null, body: text }
  return { meta: parseMiniYaml(match[1]), body: text.slice(match[0].length) }
}

//#endregion

//#region 元数据规范化

/** 把任意来源的 meta 规范化成官方 `WorkflowMeta` + 本插件扩展的 `graph`。 */
export function normalizeMeta(input, fallbackName) {
  const source = input !== null && typeof input === 'object' ? input : {}
  const name = typeof source.name === 'string' && source.name.trim() !== '' ? source.name.trim() : fallbackName
  if (typeof name !== 'string' || NAME_PATTERN.test(name) === false) {
    throw new Error(`工作流名不合法：${String(name)}（只允许小写字母、数字、点、下划线、短横线）`)
  }
  const description =
    typeof source.description === 'string' && source.description.trim() !== ''
      ? source.description.trim()
      : `工作流 ${name}`
  const meta = { name, description }
  if (typeof source.whenToUse === 'string' && source.whenToUse.trim() !== '') meta.whenToUse = source.whenToUse.trim()
  if (Array.isArray(source.phases)) {
    const phases = []
    for (const entry of source.phases) {
      if (entry === null || typeof entry !== 'object') continue
      if (typeof entry.title !== 'string' || entry.title === '') continue
      const phase = { title: entry.title }
      for (const key of ['detail', 'provider', 'model']) {
        if (typeof entry[key] === 'string' && entry[key] !== '') phase[key] = entry[key]
      }
      phases.push(phase)
    }
    if (phases.length > 0) meta.phases = phases
  }
  const graph = source.graph !== undefined && source.graph !== null ? source.graph : null
  return { meta, graph }
}

//#endregion

//#region 目录扫描

function readDefinition(file, source) {
  if (file.endsWith('.json')) {
    const parsed = JSON.parse(source)
    const { meta } = normalizeMeta(parsed?.meta, file.replace(/\.json$/, ''))
    if (typeof parsed?.script !== 'string') throw new Error('JSON 工作流缺少 `script` 字段')
    return { meta, graph: parsed?.graph ?? null, script: parsed.script }
  }
  const { meta: rawMeta, body } = splitFrontmatter(source)
  const { meta, graph } = normalizeMeta(rawMeta, file.replace(/\.js$/, ''))
  if (body.trim() === '') throw new Error('工作流脚本正文是空的')
  return { meta, graph, script: body }
}

function scanDir(dir, origin, into, invalid) {
  if (dir === null || existsSync(dir) === false) return
  let entries = []
  try {
    entries = readdirSync(dir)
  } catch (error) {
    invalid.push({ path: dir, reason: `目录无法读取：${String(error?.message ?? error)}` })
    return
  }
  for (const entry of entries) {
    if (entry.endsWith('.js') === false && entry.endsWith('.json') === false) continue
    const path = join(dir, entry)
    try {
      if (statSync(path).isFile() === false) continue
    } catch {
      continue
    }
    let definition
    try {
      definition = readDefinition(entry, readFileSync(path, 'utf8'))
    } catch (error) {
      invalid.push({ path, reason: String(error?.message ?? error) })
      continue
    }
    /*
     * 同名时用户目录优先（先扫用户目录，已存在就不覆盖）。
     * 这与 skill 的 rank 语义一致：用户的东西永远压过随包的东西。
     */
    if (into.has(definition.meta.name)) continue
    into.set(definition.meta.name, {
      ...definition,
      origin,
      path,
      file: entry,
      bytes: Buffer.byteLength(readFileSync(path, 'utf8'), 'utf8'),
    })
  }
}

/** 列出全部工作流。用户目录优先，随包目录兜底。 */
export function listWorkflows() {
  const found = new Map()
  const invalid = []
  const userRoot = userWorkflowRoot()
  const bundledRoot = bundledWorkflowRoot()
  scanDir(userRoot, 'user', found, invalid)
  scanDir(bundledRoot, 'bundled', found, invalid)
  const items = [...found.values()].sort((left, right) => left.meta.name.localeCompare(right.meta.name))
  return { items, invalid, userRoot, bundledRoot }
}

/** 读一个工作流。 */
export function readWorkflow(name) {
  if (typeof name !== 'string' || NAME_PATTERN.test(name) === false) {
    throw new Error(`工作流名不合法：${String(name)}`)
  }
  const { items } = listWorkflows()
  const hit = items.find((item) => item.meta.name === name)
  if (hit === undefined) throw new Error(`找不到工作流 ${name}（用 /workflow 看可用列表）`)
  return hit
}

/** 把一个工作流写入用户目录。已存在则覆盖（仅允许覆盖用户自己的）。 */
export function writeWorkflow(name, { meta, script }) {
  if (typeof name !== 'string' || NAME_PATTERN.test(name) === false) {
    throw new Error(`工作流名不合法：${String(name)}`)
  }
  if (typeof script !== 'string' || script.trim() === '') throw new Error('工作流脚本不能为空')
  const normalized = normalizeMeta({ ...meta, name }, name)
  const lines = ['---', `name: ${normalized.meta.name}`, `description: ${normalized.meta.description}`]
  if (normalized.meta.whenToUse !== undefined) lines.push(`whenToUse: ${normalized.meta.whenToUse}`)
  if (normalized.meta.phases !== undefined) {
    lines.push('phases:')
    for (const phase of normalized.meta.phases) {
      lines.push(`  - title: ${phase.title}`)
      if (phase.detail !== undefined) lines.push(`    detail: ${phase.detail}`)
      if (phase.provider !== undefined) lines.push(`    provider: ${phase.provider}`)
      if (phase.model !== undefined) lines.push(`    model: ${phase.model}`)
    }
  }
  lines.push('---', '')
  const path = join(userWorkflowRoot(), `${normalized.meta.name}.js`)
  writeFileSync(path, `${lines.join('\n')}${script.replace(/^\n+/, '')}`, 'utf8')
  return { path, meta: normalized.meta }
}

/** 删除用户目录里的一个工作流。随包工作流不可删。 */
export function deleteWorkflow(name) {
  const hit = readWorkflow(name)
  if (hit.origin !== 'user') throw new Error(`${name} 是随包工作流，不能删除`)
  rmSync(hit.path)
  return { path: hit.path }
}

/** 确保用户工作流目录存在（首次调用时创建）。 */
export function ensureWorkflowRoot() {
  const root = userWorkflowRoot()
  mkdirSync(root, { recursive: true })
  return root
}

//#endregion
