/**
 * 运行环境：把官方 Harness 桌面版提供的几个事实收敛到一处。
 *
 * ## 为什么依靠 process.argv
 *
 * 插件由官方宿主进程加载，宿主不会通过任何 API 告知「profile 在哪、运行时在哪」，
 * 但它在启动时把这些信息按位置放在 argv 中（Node 会剥离自己识别的选项，槽位稳定）：
 *
 *   [0] exe  [1] 宿主入口  [2] runtimeDir  [3] profileDir
 *   [4] primaryRuntime  [5] pnpmCli  [6] nodeBin
 *
 * ## 工作流脚本放在哪里
 *
 * `<DSH_HOME>/workflows/*.js`。与 skill 的存放约定一致：用户目录优先，随包目录兜底。
 * 之所以不放进 profile 的 node_modules，是因为工作流是**用户的编排资产**，
 * 不是插件的一部分 —— 升级插件不应该动它们。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** 本插件自己的 package.json。 */
export const MANIFEST = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))

/** DSH 家目录。官方桌面版与命令行版共用同一个，不做隔离。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

function argAt(index) {
  const value = process.argv[index]
  return typeof value === 'string' && value !== '' ? value : null
}

/** 运行时目录（`<resources>/app.asar/dsh`）。 */
export const RUNTIME_DIR = argAt(2)
/** 当前 profile 目录（`<DSH_HOME>/profiles/desktop`）。 */
export const PROFILE_DIR = argAt(3)

/** profile 名。 */
export const PROFILE_NAME = PROFILE_DIR === null ? 'desktop' : basename(PROFILE_DIR)

/** 本插件的包名（= 模块 id）。客户端半边靠它与 `/info` 的 `plugin` 字段比对来认宿主。 */
export const PLUGIN_ID = MANIFEST.name

/** 宿主上下文，由 index.js 在 apply() 里填。 */
export const host = {
  home: DSH_HOME,
  runtimeDir: RUNTIME_DIR,
  profileDir: PROFILE_DIR,
  state: 'ready',
  ctx: null,
  readyAt: Date.now(),
}

export function setHostContext(ctx) {
  host.ctx = ctx
}

/** 插件自己的数据目录（日志、运行记录）。 */
export function dataDir() {
  const dir = join(DSH_HOME, 'plugin-data')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 用户的工作流库目录。 */
export function userWorkflowRoot() {
  const dir = join(DSH_HOME, 'workflows')
  mkdirSync(dir, { recursive: true })
  return dir
}

/** 随包工作流目录（本插件自带的内置示例）。 */
export function bundledWorkflowRoot() {
  const dir = join(pluginRoot, 'workflows')
  return existsSync(dir) ? dir : null
}

/**
 * 随包 node。
 *
 * 宿主进程本身就是「以 Node 模式运行的 Electron」（ELECTRON_RUN_AS_NODE=1），
 * 因此 `process.execPath` 已经是一个可用的 node。这里保留函数是为了将来需要
 * spawn 子进程时（例如把工作流放到独立进程里跑）有统一的取法。
 */
export function nodeExecutable() {
  return process.execPath
}
