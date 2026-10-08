/**
 * 起一个**隔离的**第二个 Host 实例，用来端到端验证插件。
 *
 * 为什么需要它：官方桌面版把端口 19387 硬编码在 `dsh-desktop-host/lib/index.js` 的 `main()` 里，
 * 而那个实例正在跑（就是用户此刻在用的界面）。插件是宿主启动时加载的一部分，
 * 装好之后**必须重启宿主**才生效 —— 但「重启」是用户的操作，不能由插件代劳。
 *
 * 于是这里另起一个：换端口、换 DSH_HOME，因此
 *   - 不会碰到正在运行的官方实例（端口不冲突）；
 *   - 不会碰到用户的会话/凭据/storage（DSH_HOME 指向临时目录）。
 *
 * 它能验证的：宿主半边是否真的被加载、路由是否挂上、客户端 bundle 是否被列进
 * preload 清单。它**不能**验证：浏览器里的真实渲染（那必须真机看）。
 *
 * 用法：node tools/probe-host.mjs [port]
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PORT = process.argv[2] ?? '19399'
import { PLUGIN_ROOT, PROBE_HOME as PROBE_HOME_DIR, runtimeLayout } from './paths.mjs'

const LAYOUT = runtimeLayout()
const INSTALL = LAYOUT.install
const ASAR = LAYOUT.asar
const PROBE_HOME = PROBE_HOME_DIR
const PLUGIN_DIR = PLUGIN_ROOT
const HERE = `${PLUGIN_ROOT}/tools`

const HOST_ENTRY = `${ASAR}/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js`
const RUNTIME_DIR = `${ASAR}/dsh`
const PRIMARY_RUNTIME = `${RESOURCES}/runtime/primary-runtime`
const PNPM_CLI = `${RESOURCES}/runtime/pnpm/bin/pnpm.cjs`
const NODE_BIN = `${RESOURCES}/runtime/primary-runtime/dependencies/node/bin`

//#region 隔离 profile

const profileDir = join(PROBE_HOME, 'profiles', 'desktop')
rmSync(PROBE_HOME, { recursive: true, force: true })
mkdirSync(join(profileDir, 'node_modules'), { recursive: true })

writeFileSync(join(profileDir, 'cordis.yml'), '# probe profile root\n[]\n', 'utf8')
writeFileSync(
  join(profileDir, 'pnpm-workspace.yaml'),
  'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
  'utf8',
)
writeFileSync(
  join(profileDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'dsh-profile-probe',
      private: true,
      dependencies: { 'dsh-workflow-studio': `file:${PLUGIN_DIR}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'dsh-workflow-studio'] } },
    },
    null,
    2,
  )}\n`,
  'utf8',
)
writeFileSync(join(profileDir, 'cordis.patch.yml'), '# probe patch layer\n[]\n', 'utf8')

/*
 * 把插件链进探针 profile。
 *
 * 官方 `loadProfileDirectory` 从 profile 目录解析 bundle 名 —— 只写 dependencies
 * 是不够的，`node_modules/<name>` 必须真的存在。真机上这是 pnpm 干的活；
 * 探针里不跑 pnpm（会去动 registry），直接建 junction。
 */
const linkPath = join(profileDir, 'node_modules', 'dsh-workflow-studio')
symlinkSync(PLUGIN_DIR, linkPath, 'junction')
console.log(`探针 profile：${profileDir}`)
console.log(`  插件链接：${linkPath} -> ${PLUGIN_DIR}`)

//#endregion

//#region 端口改写钩子

/*
 * 官方宿主把端口硬编码成字符串 "19387"。用 ESM loader hook 在**加载期**把它换掉，
 * 避免 EADDRINUSE。钩子必须在子进程里 --import，所以写成独立文件。
 */
const hookPath = join(HERE, '_probe-port-hook.mjs')
writeFileSync(
  hookPath,
  `import { registerHooks } from 'node:module'
const port = process.env.DSH_PROBE_PORT
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.includes('dsh-desktop-host') && result?.source != null) {
      const text = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
      if (text.includes('"19387"')) {
        return { ...result, source: text.split('"19387"').join('"' + port + '"') }
      }
    }
    return result
  },
})
`,
  'utf8',
)

//#endregion

//#region 起进程

const args = [
  '--expose-internals',
  '--import',
  pathToFileURL(hookPath).href,
  HOST_ENTRY,
  RUNTIME_DIR,
  profileDir,
  PRIMARY_RUNTIME,
  PNPM_CLI,
  NODE_BIN,
]

console.log(`启动第二个宿主（端口 ${PORT}）…`)
const child = spawn(`${INSTALL}/DeepSeek Harness.exe`, args, {
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    DSH_HOME: PROBE_HOME,
    DSH_PROBE_PORT: PORT,
    DSH_PROFILE: 'desktop',
  },
  // stdout/stderr 直接继承：管道会撞上沙箱对命名管道的限制，而且这里本来就要看日志
  stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
})

let settled = false
const finish = (code, message) => {
  if (settled) return
  settled = true
  if (message !== undefined) console.log(message)
  try {
    child.kill()
  } catch {
    // 忽略
  }
  process.exit(code)
}

child.on('message', (message) => {
  if (message?.type === 'ready') {
    console.log(`\n=== READY ===\n${message.url}\n`)
    const injections = Array.isArray(message.injections) ? message.injections : []
    console.log(`注入行 ${String(injections.length)} 条：`)
    for (const row of injections) console.log(`  - ${JSON.stringify(row).slice(0, 200)}`)
    finish(0)
  } else if (message?.type === 'fatal') {
    console.error(`\n=== FATAL ===\n${message.message}\n${String(message.diagnostic).slice(0, 2000)}`)
    finish(1)
  }
})

child.on('exit', (code) => {
  finish(code === 0 ? 0 : 1, `宿主退出，code=${String(code)}`)
})

setTimeout(() => finish(1, '超时：90 秒内没有收到 ready'), 90_000)
