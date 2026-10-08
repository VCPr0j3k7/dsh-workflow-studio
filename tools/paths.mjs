/**
 * 开发工具共用的路径推导。
 *
 * ## 两条规矩
 *
 * 1. **插件自己的位置从 `import.meta.url` 推** —— 它永远正确，而且随仓库走。
 *    写死 `D:/xxx/dsh-workflow-studio` 的脚本换台机器就废了。
 * 2. **DSH 装在哪从环境变量取** —— 那台机器相关，不该出现在公开仓库里。
 *    取不到就**报错并给出怎么设**，而不是悄悄用一个写死的默认值：
 *    写死默认值会让脚本在别人的机器上跑出莫名其妙的结果，比直接报错难查得多。
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** 插件根目录（本文件在 tools/ 下）。 */
export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** DSH 家目录。官方桌面版与命令行版共用同一个。 */
export const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** 当前 profile 目录。 */
export const PROFILE_DIR =
  process.env.DSH_PROFILE_DIR ?? join(DSH_HOME, 'profiles', process.env.DSH_PROFILE ?? 'desktop')

/** 探测用的临时 DSH_HOME（不碰用户真实数据）。 */
export const PROBE_HOME = process.env.DSH_PROBE_HOME ?? join(homedir(), '.dsh-workflow-probe')

/** 一段统一的教学式报错。 */
function needEnv(name, example) {
  return new Error(
    `需要环境变量 ${name}。\n` +
      `  例如（PowerShell）：$env:${name} = "${example}"\n` +
      `  这个脚本要读 DSH 安装目录里的 app.asar —— 那是机器相关的，所以不写在仓库里。`,
  )
}

/**
 * DSH 安装目录。
 * @returns {string} 形如 `D:\DeepSeek Harness`
 */
export function installDir() {
  const install = process.env.DSH_INSTALL
  if (install === undefined || install === '') {
    throw needEnv('DSH_INSTALL', 'D:\\DeepSeek Harness')
  }
  return install.replace(/[\\/]+$/, '')
}

/**
 * `app.asar` 的绝对路径。可以直接设 `DSH_ASAR` 跳过推导。
 * @returns {string}
 */
export function asarPath() {
  const direct = process.env.DSH_ASAR
  if (direct !== undefined && direct !== '') return direct
  return `${installDir()}/resources/app.asar`
}

/**
 * 安装目录下的随包运行时路径集合。
 * @returns {{install:string, asar:string, hostEntry:string, runtimeDir:string, primaryRuntime:string, pnpmCli:string, nodeBin:string}}
 */
export function runtimeLayout() {
  const install = installDir()
  const asar = asarPath()
  return {
    install,
    asar,
    hostEntry: `${asar}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`,
    runtimeDir: `${asar}/dsh`,
    primaryRuntime: `${install}/resources/runtime/primary-runtime`,
    pnpmCli: `${install}/resources/runtime/pnpm/bin/pnpm.cjs`,
    nodeBin: `${install}/resources/runtime/primary-runtime/dependencies/node/bin`,
  }
}

/**
 * 会话日志的 `.zstd` 路径。
 * @param {string} sessionId 会话 id
 * @param {string} [cwdSlug] 会话所在工作目录在 `sessions/` 下的目录名；不给就自己找
 * @returns {string}
 */
export function sessionLogPath(sessionId, cwdSlug) {
  if (cwdSlug !== undefined) {
    return join(DSH_HOME, 'sessions', cwdSlug, sessionId, 'session.v4.jsonl.zstd')
  }
  return join(DSH_HOME, 'sessions', '<工作目录对应的那一层>', sessionId, 'session.v4.jsonl.zstd')
}
